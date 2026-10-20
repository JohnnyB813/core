#include "block/header/header_impl.hpp"
#include "chainserver/state/helpers/consensus.hpp"
#include "communication/create_payment.hpp"
#include "db/chain_db.hpp"
#include "global/globals.hpp"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <chrono>
#include <ctime>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>

static size_t recoveries;
#ifdef COUNT_SIGNATURE_RECOVERIES
extern "C" int __real_secp256k1_ecdsa_recover(const secp256k1_context*, secp256k1_pubkey*,
    const secp256k1_ecdsa_recoverable_signature*, const unsigned char*);
extern "C" int __wrap_secp256k1_ecdsa_recover(const secp256k1_context* context, secp256k1_pubkey* pubkey,
    const secp256k1_ecdsa_recoverable_signature* signature, const unsigned char* hash)
{
    ++recoveries;
    return __real_secp256k1_ecdsa_recover(context, pubkey, signature, hash);
}
#endif

static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}

// Public test keys only. The funded database below is synthetic and temporary.
static const char* signerKey = "0000000000000000000000000000000000000000000000000000000000000001";
static const char* otherKey = "0000000000000000000000000000000000000000000000000000000000000002";
static const char* unknownKey = "0000000000000000000000000000000000000000000000000000000000000003";

struct Fixture {
    ChainDB db { "" };
    BatchRegistry registry;
    PrivKey signer { signerKey };
    Address sender { signer.pubkey().address() };
    Address recipient { PrivKey(otherKey).pubkey().address() };
    PinHeight pin { Height(0) };
    Hash pinHash { Hash::genesis() };
    std::unique_ptr<chainserver::Chainstate> state;

    Fixture(const nlohmann::json& blocks, uint64_t balance = 100)
    {
        // Persist two recorded headers/bodies and seed known account balances.
        // This tests transaction admission, not validity of a mined test chain.
        auto transaction = db.transaction();
        db.insertStateEntry(sender, Funds::from_value_throw(balance), AccountId(1));
        db.insertStateEntry(recipient, Funds::from_value_throw(balance), AccountId(2));
        const Address empty(std::array<uint8_t, 20> {});
        db.insertStateEntry(empty, Funds::zero(), AccountId(3));
        for (size_t i = 0; i < 2; ++i) {
            const auto& item = blocks.at(i);
            Block block { NonzeroHeight(item.at(0).get<uint32_t>()),
                Header(hex_to_arr<80>(item.at(1).get<std::string>())),
                BodyContainer(hex_to_vec(item.at(2).get<std::string>())), {} };
            const auto [id, inserted] = db.insert_protect(block);
            check(inserted, "fixture block insertion");
            db.insert_consensus(block.height, id, HistoryId(1), AccountId(i == 0 ? 1 : 4));
        }
        transaction.commit();
        state = std::make_unique<chainserver::Chainstate>(db, registry);
    }

    PaymentCreateMessage payment(uint32_t nonce, uint64_t fee = 2, uint64_t amount = 88) const
    {
        return { pin, pinHash, signer, CompactUInt::compact(Funds::from_value_throw(fee)),
            recipient, Funds::from_value_throw(amount), NonceId(nonce) };
    }

    TxHash admit(const PaymentCreateMessage& payment, bool peer, AccountId account = AccountId(1))
    {
        if (peer) return state->insert_tx(TransferTxExchangeMessage(account, payment));
        return state->insert_tx(payment);
    }
};

static void check_recoveries(size_t expected)
{
#ifdef COUNT_SIGNATURE_RECOVERIES
    check(recoveries == expected, "unexpected signature recovery count");
#else
    (void)expected;
#endif
}

template <typename Function>
static void rejected(Fixture& fixture, Function function, int32_t expected, size_t expectedRecoveries)
{
    const auto previousSize = fixture.state->mempool().size();
    check(fixture.state->pop_mempool_log().empty(), "unconsumed admission log");
    recoveries = 0;
    try {
        function();
        throw std::runtime_error("invalid transaction accepted");
    } catch (Error error) {
        check(error.e == expected, "transaction rejection changed");
    }
    check_recoveries(expectedRecoveries);
    check(fixture.state->mempool().size() == previousSize, "rejection changed pool size");
    check(fixture.state->pop_mempool_log().empty(), "rejection changed pool log");
}

static void regressions(const nlohmann::json& blocks, size_t admissionRecoveries)
{
    for (const bool peer : { false, true }) {
        Fixture fixture(blocks);
        const auto original = fixture.payment(1);
        recoveries = 0;
        check(fixture.admit(original, peer) == original.tx_hash(fixture.pinHash), "admission hash");
        check_recoveries(admissionRecoveries);
        check(fixture.state->pop_mempool_log().size() == 1, "admission log");

        const auto replacement = fixture.payment(1, 4);
        recoveries = 0;
        const auto replacementHash = fixture.admit(replacement, peer);
        check_recoveries(admissionRecoveries);
        check(fixture.state->mempool().size() == 1, "replacement pool size");
        check(fixture.state->mempool()[replacementHash].has_value(), "replacement hash missing");
        check(!fixture.state->mempool()[original.tx_hash(fixture.pinHash)], "old hash retained");
        check(fixture.state->pop_mempool_log().size() == 2, "replacement erase/put log");
        rejected(fixture, [&] { fixture.admit(replacement, peer); }, ENONCE, admissionRecoveries);
        rejected(fixture, [&] { fixture.admit(original, peer); }, ENONCE, admissionRecoveries);
        rejected(fixture, [&] { fixture.admit(fixture.payment(2, 2, 7), peer); }, EBALANCE, admissionRecoveries);
        rejected(fixture, [&] { fixture.admit(fixture.payment(1, 8, 100), peer); }, EBALANCE, admissionRecoveries);

        PaymentCreateMessage self(fixture.pin, fixture.pinHash, fixture.signer, original.compactFee,
            fixture.sender, original.amount, NonceId(3));
        rejected(fixture, [&] { fixture.admit(self, peer); }, ESELFSEND, 1);
        rejected(fixture, [&] { fixture.admit(fixture.payment(3, 2, 0), peer); }, EZEROAMOUNT, 0);
        auto future = original;
        future.pinHeight = PinHeight(Height(32));
        rejected(fixture, [&] { fixture.admit(future, peer); }, EPINHEIGHT, 0);

        auto tampered = fixture.payment(4);
        tampered.amount = Funds::from_value_throw(87);
        rejected(fixture, [&] { fixture.admit(tampered, peer); },
            peer ? EFAKEACCID : EADDRNOTFOUND, peer ? admissionRecoveries : 1);

        auto broken = original;
        auto signature = broken.signature.serialize();
        std::fill(signature.begin(), signature.begin() + 32, 0); // r = 0 cannot recover a key
        broken.signature = RecoverableSignature(View<65>(signature.data()));
        rejected(fixture, [&] { fixture.admit(broken, peer); }, ECORRUPTEDSIG, 1);

        if (peer) {
            rejected(fixture, [&] { fixture.admit(original, true, AccountId(2)); }, EFAKEACCID, admissionRecoveries);
            rejected(fixture, [&] { fixture.admit(original, true, AccountId(999)); }, EADDRIDNOTFOUND, 1);
            rejected(fixture, [&] { fixture.admit(original, true, AccountId(3)); }, EFAKEACCID, admissionRecoveries);
        } else {
            PaymentCreateMessage unknown(fixture.pin, fixture.pinHash, PrivKey(unknownKey), original.compactFee,
                fixture.recipient, original.amount, NonceId(5));
            rejected(fixture, [&] { fixture.admit(unknown, false); }, EADDRNOTFOUND, 1);
        }

        set_config().node.minMempoolFee = CompactUInt::compact(Funds::from_value_throw(8));
        rejected(fixture, [&] { fixture.admit(original, peer); }, EMINFEE, 1);
        if (peer)
            rejected(fixture, [&] { fixture.admit(original, true, AccountId(2)); }, EMINFEE, 1);
        set_config().node.minMempoolFee = CompactUInt::smallest();

        // Rollback reinsertion uses the ordinary verifying mempool entry point.
        chainserver::RollbackResult rollback { .shrinkLength = Height(1),
            .toMempool { TransferTxExchangeMessage(AccountId(1), fixture.payment(10, 2, 1)),
                TransferTxExchangeMessage(AccountId(2), fixture.payment(11, 2, 1)) },
            .balanceUpdates {}, .chainTxIds {}, .deletionKey { 1 } };
        recoveries = 0;
        (void)fixture.state->rollback(rollback);
        check_recoveries(2);
        check(fixture.state->mempool().size() == 2, "rollback failed to reject forged account");
        check(fixture.state->pop_mempool_log().size() == 1, "rollback admission log");
    }

    Fixture fixture(blocks);
    mempool::Mempool pool;
    const auto payment = fixture.payment(1);
    const TransferTxExchangeMessage transfer(AccountId(1), payment);
    const auto hash = transfer.txhash(fixture.pinHash);
    const TransactionHeight height(fixture.pin, AccountHeight(1));
    const AddressFunds wrong { fixture.recipient, Funds::from_value_throw(100) };
    recoveries = 0;
    check(pool.insert_tx(transfer, height, hash, wrong) == EFAKEACCID, "ordinary entry trusts supplied account");
    check_recoveries(1);
    set_config().node.minMempoolFee = CompactUInt::compact(Funds::from_value_throw(8));
    recoveries = 0;
    check(pool.insert_tx(transfer, height, hash, wrong) == EMINFEE, "ordinary entry rejection order");
    check_recoveries(0);
    set_config().node.minMempoolFee = CompactUInt::smallest();
    check(pool.size() == 0 && pool.pop_log().empty(), "ordinary rejection mutated pool");
}

static void benchmark(const nlohmann::json& blocks, bool peer)
{
    constexpr size_t warmup = 256, samples = 4096;
    Fixture fixture(blocks, 1000000000000);
    std::vector<PaymentCreateMessage> payments;
    std::vector<TransferTxExchangeMessage> transfers;
    for (size_t i = 0; i < warmup + samples; ++i) {
        payments.push_back(fixture.payment(uint32_t(i), 2, 1));
        transfers.emplace_back(AccountId(1), payments.back());
    }
    auto admit = [&](size_t i) {
        if (peer) return fixture.state->insert_tx(transfers[i]);
        return fixture.state->insert_tx(payments[i]);
    };
    for (size_t i = 0; i < warmup; ++i) (void)admit(i);
    std::vector<double> durations;
    durations.reserve(samples);
    recoveries = 0;
    const auto cpuStart = std::clock();
    for (size_t i = warmup; i < warmup + samples; ++i) {
        const auto start = std::chrono::steady_clock::now();
        (void)admit(i);
        durations.push_back(std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - start).count());
    }
    const auto cpuUs = 1000000.0 * (std::clock() - cpuStart) / CLOCKS_PER_SEC;
    check(fixture.state->mempool().size() == warmup + samples, "benchmark admission count");
    std::sort(durations.begin(), durations.end());
    std::cout << nlohmann::json { { "path", peer ? "peer" : "api" }, { "samples", samples },
        { "p50_us", durations[samples / 2] }, { "p95_us", durations[samples * 95 / 100] },
        { "p99_us", durations[samples * 99 / 100] }, { "cpu_us", cpuUs },
        { "recoveries", recoveries } }.dump() << '\n';
}

int main(int argc, char** argv)
{
    try {
        check(argc == 2 || argc == 4, "usage: mempool_admission FIXTURE [--bench api|peer | --expected-recoveries N]");
        std::ifstream input(argv[1]);
        nlohmann::json fixture;
        input >> fixture;
        ECC_Start();
        struct StopECC { ~StopECC() { ECC_Stop(); } } stopECC;
        set_config().node.minMempoolFee = CompactUInt::smallest();
        if (argc == 4 && std::string(argv[2]) == "--bench") {
            check(std::string(argv[3]) == "api" || std::string(argv[3]) == "peer", "unknown admission path");
            benchmark(fixture.at("blocks"), std::string(argv[3]) == "peer");
        } else {
            check(argc == 2 || std::string(argv[2]) == "--expected-recoveries", "unknown test option");
            regressions(fixture.at("blocks"), argc == 2 ? 1 : std::stoul(argv[3]));
            std::cout << "mempool admission checks passed with real signatures\n";
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
    } catch (Error error) {
        std::cerr << error.strerror() << '\n';
    }
    return 1;
}
