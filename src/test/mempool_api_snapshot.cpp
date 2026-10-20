#include "api/http/json.hpp"
#include "api/types/all.hpp"
#include "block/header/header_impl.hpp"
#include "chainserver/state/state.hpp"
#include "communication/create_payment.hpp"
#include "db/chain_db.hpp"
#include "general/hex.hpp"
#include "global/globals.hpp"
#include <fstream>
#include <iostream>
#include <stdexcept>

using json = nlohmann::json;
static size_t recoveries = 0;
#ifdef COUNT_SIGNATURE_RECOVERIES
extern "C" int __real_secp256k1_ecdsa_recover(const secp256k1_context*, secp256k1_pubkey*,
    const secp256k1_ecdsa_recoverable_signature*, const unsigned char*);
extern "C" int __wrap_secp256k1_ecdsa_recover(const secp256k1_context* context, secp256k1_pubkey* key,
    const secp256k1_ecdsa_recoverable_signature* signature, const unsigned char* hash)
{
    ++recoveries;
    return __real_secp256k1_ecdsa_recover(context, key, signature, hash);
}
#endif

static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}

// Independent reference: recover each sender exactly as the original formatter did.
static json original_json(const API::MempoolEntries& snapshot)
{
    json entries = json::array();
    for (const auto& entry : snapshot.entries) {
        entries.push_back({ { "fromAddress", entry.from_address(entry.txHash).to_string() },
            { "pinHeight", entry.pin_height() }, { "txHash", serialize_hex(entry.txHash) },
            { "nonceId", entry.nonce_id() }, { "fee", entry.fee().to_string() },
            { "feeE8", entry.fee().E8() }, { "toAddress", entry.toAddr.to_string() },
            { "amount", entry.amount.to_string() }, { "amountE8", entry.amount.E8() } });
    }
    return { { "data", entries } };
}

int main(int argc, char** argv) try
{
    check(argc == 2, "expected public block fixture");
    ECC_Start();
    struct StopECC { ~StopECC() { ECC_Stop(); } } stopECC;
    set_config().node.minMempoolFee = CompactUInt::smallest();
    // Public fixture keys only; the funded database is synthetic and never networked.
    const PrivKey first("0000000000000000000000000000000000000000000000000000000000000001");
    const PrivKey second("0000000000000000000000000000000000000000000000000000000000000002");
    ChainDB db("");
    BatchRegistry registry;
    json fixture;
    std::ifstream(argv[1]) >> fixture;
    {
        auto transaction = db.transaction();
        db.insertStateEntry(first.pubkey().address(), Funds::from_value_throw(100000), AccountId(1));
        db.insertStateEntry(second.pubkey().address(), Funds::from_value_throw(100000), AccountId(2));
        for (unsigned i = 0; i < 2; ++i) {
            const auto& row = fixture.at("blocks").at(i);
            const Block block { NonzeroHeight(i + 1), Header(hex_to_arr<80>(row[1].get<std::string>())),
                BodyContainer(hex_to_vec(row[2].get<std::string>())), {} };
            const auto [id, inserted] = db.insert_protect(block);
            check(inserted, "seed block insertion failed");
            db.insert_consensus(block.height, id, HistoryId(1), AccountId(i == 0 ? 1 : 3));
        }
        transaction.commit();
    }
    chainserver::State state(db, registry, {});
    for (unsigned payer = 0; payer < 2; ++payer) {
        for (unsigned nonce = 0; nonce < 8; ++nonce) {
            const PaymentCreateMessage payment { PinHeight(Height(0)), Hash::genesis(), payer ? second : first,
                CompactUInt::compact(Funds::from_value_throw(2)),
                payer ? first.pubkey().address() : second.pubkey().address(),
                Funds::from_value_throw(10), NonceId(nonce) };
            state.append_gentx(payment);
        }
    }
    const auto snapshot = state.api_get_mempool(2000);
    check(snapshot.entries.size() == 16, "multi-payer snapshot size differs");
    const auto expected = original_json(snapshot);
    recoveries = 0;
    check(jsonmsg::to_json(snapshot).dump() == expected.dump(), "mempool response changed");
    for (const auto& entry : snapshot.entries) {
        const auto transaction = state.api_get_tx(entry.txHash);
        check(transaction && std::get<API::TransferTransaction>(*transaction).fromAddress == entry.fromAddress,
            "pending transaction sender differs from its owned snapshot");
    }
#ifdef COUNT_SIGNATURE_RECOVERIES
    check(recoveries == 0, "formatting or pending lookup repeated signature recovery");
#endif
    const PaymentCreateMessage replacement { PinHeight(Height(0)), Hash::genesis(), first,
        CompactUInt::compact(Funds::from_value_throw(3)), second.pubkey().address(),
        Funds::from_value_throw(10), NonceId(0) };
    state.append_gentx(replacement);
    const auto replaced = state.api_get_mempool(2000);
    check(replaced.entries.size() == 16, "replacement changed the entry count");
    check(jsonmsg::to_json(replaced) == original_json(replaced), "replacement sender output differs");
    set_config().node.minMempoolFee = CompactUInt::compact(Funds::from_value_throw(100));
    check(state.on_mempool_constraint_update() == 16, "fee pruning count differs");
    check(state.api_get_mempool(2000).entries.empty(), "fee pruning retained entries");
    check(jsonmsg::to_json(snapshot) == expected, "snapshot borrowed sender storage erased by pruning");
    check(!state.api_get_tx(snapshot.entries.front().txHash), "pruned pending transaction remained visible");

    // A fork may reuse an account ID while transactions pinned before the fork
    // still exist. Match the sender to each admitted transaction, not just its ID.
    set_config().node.minMempoolFee = CompactUInt::smallest();
    mempool::Mempool reused;
    auto admitReused = [&](const PrivKey& payer, unsigned nonce, const Address& recipient) {
        const PaymentCreateMessage payment { PinHeight(Height(0)), Hash::genesis(), payer,
            CompactUInt::compact(Funds::from_value_throw(1)), recipient,
            Funds::from_value_throw(10), NonceId(nonce) };
        const TransferTxExchangeMessage transfer(AccountId(1), payment);
        const auto hash = payment.tx_hash(Hash::genesis());
        reused.insert_tx_throw(transfer, TransactionHeight(PinHeight(Height(0)), AccountHeight(1)), hash,
            AddressFunds { payer.pubkey().address(), Funds::from_value_throw(100000) });
        return hash;
    };
    const auto oldHash = admitReused(first, 50, second.pubkey().address());
    const auto newHash = admitReused(second, 51, first.pubkey().address());
    check(reused.verified_address(oldHash) == first.pubkey().address(), "old transaction sender differs");
    check(reused.verified_address(newHash) == second.pubkey().address(), "sender cache confused reused account ID");
    std::cout << "Mempool API snapshots: multiple payers, pending lookup, replacement, owned lifetime and reused IDs passed\n";
} catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
}
