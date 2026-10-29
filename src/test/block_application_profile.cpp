// Attribution only: signed synthetic bodies through the real BlockApplier.
// Seeded balances and unmined headers are not full consensus-valid blocks.
#include "api/types/all.hpp"
#include "block/body/generator.hpp"
#include "block/chain/header_chain.hpp"
#include "block/header/generator.hpp"
#include "block/header/header_impl.hpp"
#include "chainserver/state/transactions/block_applier.hpp"
#include "communication/create_payment.hpp"
#include "db/chain_db.hpp"
#include "general/is_testnet.hpp"
#include "general/params.hpp"
#include "global/globals.hpp"
#include "nlohmann/json.hpp"
#include "sqlite3.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <ctime>
#include <filesystem>
#include <iostream>
#ifdef __linux__
#include <sys/resource.h>
#endif

using Clock = std::chrono::steady_clock;
using json = nlohmann::json;
static std::atomic<size_t> recoveries { 0 };
static sqlite3* profiledDatabase = nullptr;
static int capture_database(sqlite3* db, char**, const sqlite3_api_routines*)
{
    profiledDatabase = db;
    return SQLITE_OK;
}
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
static double elapsed(Clock::time_point a, Clock::time_point b)
{
    return std::chrono::duration<double, std::micro>(b - a).count();
}
static Funds funds(uint64_t value) { return Funds::from_value_throw(value); }
static constexpr uint64_t initialBalance = 1000000;
static constexpr uint64_t amount = 1, fee = 2;

struct Fixture {
    ChainDB db;
    Headerchain headers;
    chainserver::TransactionIds baseIds;
    PrivKey signer { "0000000000000000000000000000000000000000000000000000000000000001" };
    Address sender { signer.pubkey().address() };
    Address recipient { PrivKey("0000000000000000000000000000000000000000000000000000000000000002").pubkey().address() };
    Address miner { PrivKey("0000000000000000000000000000000000000000000000000000000000000003").pubkey().address() };

    explicit Fixture(const std::filesystem::path& path) : db(path.string(), "wal")
    {
        auto transaction = db.transaction();
        db.insertStateEntry(sender, funds(initialBalance), AccountId(1));
        db.insertStateEntry(recipient, Funds::zero(), AccountId(2));
        db.insertStateEntry(miner, Funds::zero(), AccountId(3));
        transaction.commit();
    }
    Block make_block(unsigned count)
    {
        std::vector<TransferTxExchangeMessage> transfers;
        transfers.reserve(count);
        for (unsigned i = 0; i < count; ++i) {
            PaymentCreateMessage payment(PinHeight(Height(0)), Hash::genesis(), signer,
                CompactUInt::compact(funds(fee)), recipient, funds(amount), NonceId(i + 1));
            transfers.emplace_back(AccountId(1), payment);
        }
        const NonzeroHeight height { uint32_t(1) };
        auto body = generate_body(db, height, miner, transfers);
        check(body.view(height).valid(), "generated body is well formed");
        HeaderGenerator generator(Hash::genesis(), body.view(height), TargetV2::genesis_testnet(), 1700000000, height);
        return { height, generator.serialize(0), std::move(body), {} };
    }
    void unchanged()
    {
        check(db.fetch_account(AccountId(1)).funds == funds(initialBalance), "rollback restores sender");
        check(db.fetch_account(AccountId(2)).funds == Funds::zero(), "rollback restores recipient");
        check(db.fetch_account(AccountId(3)).funds == Funds::zero(), "rollback restores miner");
        check(db.next_history_id() == HistoryId(1) && db.next_state_id() == AccountId(4), "rollback restores cache counters");
        check(db.consensus_block_ids(Height(1), Height(2)).empty(), "rollback restores consensus");
    }
};

static json sample(Fixture& fixture, const Block& original, unsigned count, bool readback, bool detailed)
{
    fixture.unchanged();
    const auto hash = original.header.hash();
    auto trace = latency::make_trace(1, hash, 1);
    latency::Context context(trace);
    json result;
    {
        auto transaction = fixture.db.transaction();
        const auto cpuStart = std::clock();
        const auto began = Clock::now();
        auto [id, inserted] = fixture.db.insert_protect(original);
        const auto insertedAt = Clock::now();
        std::optional<std::pair<BlockId, Block>> stored;
        if (readback) stored = fixture.db.get_block(hash);
        const auto loadedAt = Clock::now();
        check(inserted, "each sample inserts a new protected block");
        check(!readback || (stored && stored->first == id), "database readback identity");
        const Block& block = readback ? stored->second : original;
        BodyView body = block.body_view();
        chainserver::BlockApplier applier(fixture.db, fixture.headers, fixture.baseIds, true);
        recoveries = 0;
        const auto applied = applier.apply_block(body, block.header, block.height, id);
        const auto appliedAt = Clock::now();
        stored.reset();
        const auto ended = Clock::now();
        const double cpuUs = 1000000.0 * (std::clock() - cpuStart) / CLOCKS_PER_SEC;
        result = {{"insert_us", elapsed(began, insertedAt)}, {"readback_us", elapsed(insertedAt, loadedAt)},
            {"apply_us", elapsed(loadedAt, appliedAt)}, {"total_us", elapsed(began, ended)}, {"cpu_us", cpuUs},
            {"validation_us", trace->us[size_t(latency::Phase::TransactionValidation)].load()},
            {"state_write_us", trace->us[size_t(latency::Phase::DatabaseWrite)].load()}};
        check(applied.transfers.size() == count && applied.rewards.size() == 1, "all transactions applied");
#ifdef COUNT_SIGNATURE_RECOVERIES
        check(recoveries == count, "every transfer signature is recovered exactly once");
#endif
        check(fixture.db.fetch_account(AccountId(1)).funds == funds(initialBalance - count * (amount + fee)), "sender balance");
        check(fixture.db.fetch_account(AccountId(2)).funds == funds(count * amount), "recipient balance");
        check(fixture.db.fetch_account(AccountId(3)).funds == Funds::sum_throw(original.height.reward(), funds(count * fee)), "reward and fees");
        check(fixture.db.next_history_id() == HistoryId(uint64_t(count) + 2), "every history entry written");
        check(fixture.db.consensus_block_ids(Height(1), Height(2)) == std::vector<BlockId> { id }, "consensus row written");
        const auto undo = fixture.db.get_block_undo(id);
        check(undo && std::get<0>(*undo) == original.header && std::get<1>(*undo) == original.body.data()
            && !std::get<2>(*undo).empty(), "stored header/body and undo survive application");
        if (detailed) {
            const auto history = fixture.db.lookupHistoryRange(HistoryId(1), HistoryId(uint64_t(count) + 2));
            check(history.size() == count + 1, "complete history");
            json hashes = json::array();
            for (const auto& [hash, data] : history)
                hashes.push_back({ serialize_hex(hash), serialize_hex(data) });
            result["history"] = std::move(hashes);
            result["undo"] = serialize_hex(std::get<2>(*undo));
        }
        // Roll back so every sample has exactly the same funded state and IDs.
        // Durable COMMIT and header/PoW checks are deliberately outside this
        // component profile, so direct use is only an optimistic upper bound.
    }
    fixture.unchanged();
    check(!fixture.db.lookup_block_id(original.header.hash()), "sample block rolled back");
    return result;
}

static void invalid_signature(Fixture& fixture, Block block, bool readback)
{
    std::fill(block.body.data().end() - 65, block.body.data().end(), uint8_t(0));
    bool rejected = false;
    {
        auto transaction = fixture.db.transaction();
        auto [id, inserted] = fixture.db.insert_protect(block);
        check(inserted, "invalid fixture inserted for component rejection test");
        const auto stored = readback ? fixture.db.get_block(block.header.hash()) : std::nullopt;
        const auto& source = readback ? stored->second : block;
        chainserver::BlockApplier applier(fixture.db, fixture.headers, fixture.baseIds, true);
        try { (void)applier.apply_block(source.body_view(), source.header, source.height, id); }
        catch (Error) { rejected = true; }
    }
    check(rejected, "unrecoverable signature rejected");
    fixture.unchanged();
}

static json batch_readback(Fixture& fixture, const Block& original, unsigned blocks, unsigned iterations)
{
    // Model inserting a contiguous download batch before reading its bodies.
    // Headers are distinct and unmined; no multi-block consensus is claimed.
    std::vector<Block> input(blocks, original);
    std::vector<Hash> hashes;
    for (unsigned i = 0; i < blocks; ++i) {
        input[i].header[79] = uint8_t(i);
        input[i].header[78] = uint8_t(i >> 8);
        hashes.push_back(input[i].header.hash());
    }
    json samples = json::array();
    for (unsigned iteration = 0; iteration < iterations + 8; ++iteration) {
        auto transaction = fixture.db.transaction();
        std::vector<BlockId> ids;
        for (const auto& block : input) {
            auto [id, inserted] = fixture.db.insert_protect(block);
            check(inserted, "batch inserts every block");
            ids.push_back(id);
        }
        int misses = 0, highwater = 0;
        check(sqlite3_db_status(profiledDatabase, SQLITE_DBSTATUS_CACHE_MISS, &misses, &highwater, 1) == SQLITE_OK, "reset cache miss counter");
        std::vector<double> reads;
        for (unsigned i = 0; i < blocks; ++i) {
            const auto began = Clock::now();
            const auto stored = fixture.db.get_block(hashes[i]);
            const auto ended = Clock::now();
            reads.push_back(elapsed(began, ended));
            check(stored && stored->first == ids[i] && stored->second == input[i], "batch read returns exact persisted bytes");
        }
        check(sqlite3_db_status(profiledDatabase, SQLITE_DBSTATUS_CACHE_MISS, &misses, &highwater, 0) == SQLITE_OK, "read cache miss counter");
        if (iteration >= 8) samples.push_back({{"read_us", reads}, {"cache_misses", misses}});
    }
    fixture.unchanged();
    for (const auto& hash : hashes) check(!fixture.db.lookup_block_id(hash), "batch rollback removes all blocks");
    return {{"blocks", blocks}, {"body_bytes", original.body.size()}, {"iterations", iterations},
        {"samples", std::move(samples)}, {"scope", "insert-all then read-all cache-pressure attribution; no block application or commit"}};
}

int main(int argc, char** argv) try
{
    const bool batch = argc == 4 && std::string_view(argv[1]) == "--batch-readback";
    check(argc == 3 || batch, "usage: block_application_profile TRANSFERS ITERATIONS | --batch-readback BLOCKS ITERATIONS");
    // With all addresses already present: 10-byte prefix, address count,
    // 16-byte reward, and a four-byte transfer count precede 99-byte transfers.
    constexpr auto maximumTransfers = (MAXBLOCKSIZE - 32) / BodyView::TransferSize;
    const auto count = batch ? maximumTransfers : std::stoul(argv[1]);
    const auto iterations = std::stoul(argv[batch ? 3 : 2]);
    const auto blocks = batch ? std::stoul(argv[2]) : 0;
    check(count <= maximumTransfers && iterations >= 20 && iterations <= 10000, "invalid profile bounds");
    check(!batch || (blocks > 0 && blocks <= 300), "invalid batch bounds");
    enable_testnet();
    spdlog::set_level(spdlog::level::warn);
    ECC_Start();
    struct StopECC { ~StopECC() { ECC_Stop(); } } stopECC;
    const auto directory = std::filesystem::temp_directory_path()
        / ("wart-application-profile-" + std::to_string(Clock::now().time_since_epoch().count()));
    check(std::filesystem::create_directory(directory), "unique disposable directory");
    struct Cleanup { std::filesystem::path path; ~Cleanup() { std::filesystem::remove_all(path); } } cleanup { directory };
    latency::Runtime runtime(latency::Mode::Summary, (directory / "latency").string());
    check(sqlite3_auto_extension(reinterpret_cast<void(*)()>(capture_database)) == SQLITE_OK, "capture test database");
    Fixture fixture(directory / "chain.db");
    const auto block = fixture.make_block(count);
    if (batch) {
        std::cout << batch_readback(fixture, block, blocks, iterations).dump() << '\n';
        return 0;
    }
    const auto originalBody = block.body.data();
    const auto baseline = sample(fixture, block, count, true, true);
    const auto direct = sample(fixture, block, count, false, true);
    check(baseline["history"] == direct["history"] && baseline["undo"] == direct["undo"], "identical history and undo bytes");
    if (count) {
        invalid_signature(fixture, block, true);
        invalid_signature(fixture, block, false);
    }
    for (unsigned warmup = 0; warmup < 8; ++warmup) {
        (void)sample(fixture, block, count, true, false);
        (void)sample(fixture, block, count, false, false);
    }
    json samples { {"readback", json::array()}, {"direct", json::array()} };
    for (unsigned i = 0; i < iterations; ++i) {
        for (const bool readback : { i % 2 == 0, i % 2 != 0 })
            samples[readback ? "readback" : "direct"].push_back(sample(fixture, block, count, readback, false));
    }
    check(block.body.data() == originalBody, "input body never mutated");
    long peakRss = 0;
#ifdef __linux__
    rusage usage {};
    if (getrusage(RUSAGE_SELF, &usage) == 0) peakRss = usage.ru_maxrss;
#endif
    std::cout << json { {"transfers", count}, {"iterations", iterations}, {"body_bytes", block.body.size()},
        {"samples", std::move(samples)}, {"peak_rss_kib", peakRss}, {"signature_count_checked",
#ifdef COUNT_SIGNATURE_RECOVERIES
        true
#else
        false
#endif
        }, {"scope", "signed synthetic body component; seeded balances, unmined headers, rollback instead of commit"} }.dump() << '\n';
    return 0;
} catch (Error error) {
    std::cerr << "application profile failed: " << error.strerror() << '\n';
    return 1;
} catch (const std::exception& error) {
    std::cerr << "application profile failed: " << error.what() << '\n';
    return 1;
}
