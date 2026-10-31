#include "api/types/all.hpp"
#include "block/chain/history/history.hpp"
#include "block/header/header_impl.hpp"
#include "chainserver/state/state.hpp"
#include "communication/create_payment.hpp"
#include "db/chain_db.hpp"
#include "general/hex.hpp"
#include "global/globals.hpp"
#include "nlohmann/json.hpp"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>

static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}

static void one(const std::string& path, const std::string& mode, const nlohmann::json& fixture)
{
    // Public test keys. Different senders can sign the same hash because the
    // transfer hash commits to the payment fields, but not the sender/signature.
    const PrivKey first("0000000000000000000000000000000000000000000000000000000000000001");
    const PrivKey second("0000000000000000000000000000000000000000000000000000000000000002");
    const PrivKey recipient("0000000000000000000000000000000000000000000000000000000000000003");
    const auto firstAddress = first.pubkey().address();
    const auto secondAddress = second.pubkey().address();
    const auto toAddress = recipient.pubkey().address();
    const auto fee = CompactUInt::compact(Funds::from_value_throw(2));
    const auto amount = Funds::from_value_throw(10);
    const PinHeight pinHeight(Height(0));
    const NonceId nonce(7);
    const PaymentCreateMessage firstPayment(pinHeight, Hash::genesis(), first, fee, toAddress, amount, nonce);
    const PaymentCreateMessage secondPayment(pinHeight, Hash::genesis(), second, fee, toAddress, amount, nonce);
    const auto hash = firstPayment.tx_hash(Hash::genesis());
    check(hash == secondPayment.tx_hash(Hash::genesis()), "different senders must reproduce the shared hash");
    check(firstAddress != secondAddress, "collision needs distinct senders");
    check(firstPayment.valid_signature(Hash::genesis(), firstAddress), "first signature is valid");
    check(secondPayment.valid_signature(Hash::genesis(), secondAddress), "second signature is valid");
    const auto pinNonce = PinNonce::make_pin_nonce(nonce, NonzeroHeight(1u), pinHeight);
    check(pinNonce.has_value(), "valid fixture pin nonce");
    const auto firstData = history::serialize(history::TransferData { AccountId(1), fee, AccountId(3), amount, *pinNonce });
    const auto secondData = history::serialize(history::TransferData { AccountId(2), fee, AccountId(3), amount, *pinNonce });
    RewardInternal reward(AccountId(3), Funds::from_value_throw(20), NonzeroHeight(2u), 0);
    reward.toAddress = toAddress;
    const history::Entry rewardEntry(reward);
    Hash missing = hash;
    missing.back() ^= 1;

    auto verify = [&](ChainDB& db) {
        for (unsigned repeat = 0; repeat < 3; ++repeat) {
            check(!db.lookup_history(missing), "missing lookup stays empty");
            const auto unique = db.lookup_history(rewardEntry.hash);
            check(unique && unique->second == HistoryId(2) && unique->first == rewardEntry.data,
                "unique lookup retains its history ID and bytes");
            const auto duplicate = db.lookup_history(hash);
            check(duplicate && duplicate->second == HistoryId(1) && duplicate->first == firstData,
                "duplicate lookup selects the earliest history entry");
            const auto firstById = db.lookup_history(HistoryId(1));
            const auto rewardById = db.lookup_history(HistoryId(2));
            const auto secondById = db.lookup_history(HistoryId(3));
            check(firstById && firstById->first == firstData && firstById->second == hash,
                "history ID 1 resolves the first transfer");
            check(rewardById && rewardById->first == rewardEntry.data && rewardById->second == rewardEntry.hash,
                "history ID 2 resolves the reward");
            check(secondById && secondById->first == secondData && secondById->second == hash,
                "history ID 3 distinguishes a same-hash transfer");
            check(!db.lookup_history(HistoryId(0)) && !db.lookup_history(HistoryId(4))
                    && !db.lookup_history(HistoryId(std::numeric_limits<uint64_t>::max())),
                "missing and out-of-range history IDs stay empty");
        }
        const auto all = db.lookupHistoryRange(HistoryId(1), HistoryId(4));
        check(all.size() == 3 && all.front().first == hash && all.back().first == hash,
            "both colliding entries remain in history");
        BatchRegistry registry;
        chainserver::State state(db, registry, {});
        check(!state.api_get_tx(missing), "missing API lookup stays empty");
        check(!state.api_get_tx(HistoryId(0)) && !state.api_get_tx(HistoryId(4))
                && !state.api_get_tx(HistoryId(std::numeric_limits<uint64_t>::max())),
            "missing and out-of-range API history IDs stay empty");
        const auto transaction = state.api_get_tx(hash);
        check(transaction && std::holds_alternative<API::TransferTransaction>(*transaction), "API returns a transfer");
        const auto& transfer = std::get<API::TransferTransaction>(*transaction);
        check(transfer.txhash == hash && transfer.fromAddress == firstAddress && transfer.toAddress == toAddress,
            "API returns the earliest sender and recipient");
        check(transfer.amount == amount && transfer.fee == fee.uncompact() && transfer.nonceId == nonce
                && transfer.pinHeight == pinHeight,
            "API retains payment fields");
        const Header firstHeader(hex_to_arr<80>(fixture.at("blocks").at(0).at(1).get<std::string>()));
        check(transfer.height == Height(1) && transfer.confirmations == 3
                && transfer.timestamp == firstHeader.timestamp(),
            "API returns the earliest confirmation metadata");
        const auto firstById = state.api_get_tx(HistoryId(1));
        const auto secondById = state.api_get_tx(HistoryId(3));
        check(firstById && std::holds_alternative<API::TransferTransaction>(*firstById)
                && std::get<API::TransferTransaction>(*firstById).fromAddress == firstAddress,
            "API history ID 1 returns the first sender");
        check(secondById && std::holds_alternative<API::TransferTransaction>(*secondById),
            "API history ID 3 returns a transfer");
        const auto& secondTransfer = std::get<API::TransferTransaction>(*secondById);
        check(secondTransfer.txhash == hash && secondTransfer.fromAddress == secondAddress
                && secondTransfer.height == Height(3) && secondTransfer.confirmations == 1,
            "API history ID 3 returns the second sender and confirmation");
        const auto rewardTransaction = state.api_get_tx(rewardEntry.hash);
        check(rewardTransaction && std::holds_alternative<API::RewardTransaction>(*rewardTransaction), "API reward lookup still works");
        const auto& foundReward = std::get<API::RewardTransaction>(*rewardTransaction);
        check(foundReward.toAddress == toAddress && foundReward.amount == reward.amount
                && foundReward.height == Height(2) && foundReward.confirmations == 2,
            "API retains reward fields and confirmation metadata");
        const auto rewardById = state.api_get_tx(HistoryId(2));
        check(rewardById && std::holds_alternative<API::RewardTransaction>(*rewardById)
                && std::get<API::RewardTransaction>(*rewardById).txhash == rewardEntry.hash,
            "API history ID 2 returns the reward");
        state.append_gentx(secondPayment);
        const auto pending = state.api_get_tx(hash);
        check(pending && std::holds_alternative<API::TransferTransaction>(*pending), "pending lookup still works");
        const auto& pendingTransfer = std::get<API::TransferTransaction>(*pending);
        check(pendingTransfer.fromAddress == secondAddress && pendingTransfer.height == Height(0)
                && pendingTransfer.confirmations == 0,
            "pending transaction still takes precedence over confirmed matches");
        const auto confirmedById = state.api_get_tx(HistoryId(1));
        check(confirmedById && std::get<API::TransferTransaction>(*confirmedById).fromAddress == firstAddress
                && std::get<API::TransferTransaction>(*confirmedById).height == Height(1),
            "history ID lookup remains confirmed when the same hash is pending");
    };

    {
        ChainDB db(path, mode);
        auto transaction = db.transaction();
        for (const auto& address : { firstAddress, secondAddress, toAddress })
            db.insertStateEntry(address, Funds::from_value_throw(100000), db.next_state_id());
        for (unsigned i = 0; i < 3; ++i) {
            const auto& row = fixture.at("blocks").at(i);
            const Block block { NonzeroHeight(i + 1), Header(hex_to_arr<80>(row.at(1).get<std::string>())),
                BodyContainer(hex_to_vec(row.at(2).get<std::string>())), {} };
            const auto [id, inserted] = db.insert_protect(block);
            check(inserted, "seed recorded block");
            db.insert_consensus(block.height, id, HistoryId(uint64_t(i + 1)), AccountId(i == 0 ? 1 : 4));
        }
        check(db.insertHistory(hash, firstData) == HistoryId(1), "insert first transfer");
        const auto unique = db.lookup_history(hash);
        check(unique && unique->first == firstData && unique->second == HistoryId(1), "ordinary transfer lookup");
        check(db.insertHistory(rewardEntry.hash, rewardEntry.data) == HistoryId(2), "insert unrelated reward");
        check(db.insertHistory(hash, secondData) == HistoryId(3), "insert colliding transfer");
        transaction.commit();
        verify(db);
    }
    if (!path.empty()) {
        ChainDB reopened(path, mode);
        verify(reopened);
    }
}

int main(int argc, char** argv) try
{
    check(argc == 2, "public genesis fixture path required");
    ECC_Start();
    struct StopECC { ~StopECC() { ECC_Stop(); } } stopECC;
    set_config().node.minMempoolFee = CompactUInt::smallest();
    nlohmann::json fixture;
    std::ifstream(argv[1]) >> fixture;
    check(fixture.at("base_height") == 0 && fixture.at("blocks").size() >= 3, "genesis fixture required");
    const auto directory = std::filesystem::temp_directory_path()
        / ("wart-transaction-lookup-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    check(std::filesystem::create_directory(directory), "unique test directory");
    struct Cleanup { std::filesystem::path path; ~Cleanup() { std::filesystem::remove_all(path); } } cleanup { directory };
    one("", "delete", fixture);
    one((directory / "delete.db").string(), "delete", fixture);
    one((directory / "wal.db").string(), "wal", fixture);
    std::cout << "transaction lookup: hash collisions, distinct history IDs, bounds, pending precedence and restart passed\n";
} catch (const std::exception& error) {
    std::cerr << "transaction lookup failed: " << error.what() << '\n';
    return 1;
}
