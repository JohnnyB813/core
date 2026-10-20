// Synthetic retention bookkeeping; consensus acceptance is tested by node_replay.
#include "chainserver/state/helpers/consensus.hpp"
#include "chainserver/state/helpers/past_chains.hpp"
#include "db/chain_db.hpp"
#include "fault_vfs.hpp"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <chrono>
#include <ctime>
#include <filesystem>
#include <iostream>
#include <string_view>

using Clock = std::chrono::steady_clock;
using json = nlohmann::json;
namespace chainserver {
struct BlockCacheTestAccess {
    static void discard(BlockCache& cache, uint64_t key, bool due, unsigned order = 0)
    {
        cache.gcSchedule.emplace(std::chrono::system_clock::now()
                + (due ? -std::chrono::hours(1) : std::chrono::hours(1))
                + std::chrono::nanoseconds(order),
            BlockCache::DeleteScheduleEntry { BlockCache::DiscardedStageSchedule {}, DeletionKey(key) });
    }
    static void expire(BlockCache& cache)
    {
        // Exact timestamp collisions must retain every schedule.
        decltype(cache.gcSchedule) due;
        const auto when = std::chrono::system_clock::now() - std::chrono::hours(1);
        while (!cache.gcSchedule.empty()) {
            auto entry = cache.gcSchedule.extract(cache.gcSchedule.begin());
            entry.key() = when;
            due.insert(std::move(entry));
        }
        cache.gcSchedule = std::move(due);
    }
    static size_t pending(const BlockCache& cache) { return cache.gcSchedule.size(); }
};
}
using Access = chainserver::BlockCacheTestAccess;

static sqlite3* captured = nullptr;
static unsigned deletes = 0, transactions = 0;
static int trace(unsigned, void*, void* statement, void*)
{
    const auto* query = sqlite3_sql(static_cast<sqlite3_stmt*>(statement));
    if (query) {
        std::string_view text(query);
        deletes += text.starts_with("DELETE ");
        transactions += text.starts_with("BEGIN");
    }
    return 0;
}
static int observe(sqlite3* db, char**, const sqlite3_api_routines*)
{
    captured = db;
    return sqlite3_trace_v2(db, SQLITE_TRACE_STMT, trace, nullptr);
}
static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}
static void collect(chainserver::BlockCache& cache, ChainDB& db)
{
#ifdef GC_REFERENCE_TRANSACTION
    auto transaction = db.transaction();
    cache.garbage_collect(db);
    transaction.commit();
#else
    cache.garbage_collect(db);
#endif
}
static int deny_refs(void*, int action, const char* table, const char*, const char*, const char*)
{
    return action == SQLITE_DELETE && table && std::string_view(table) == "Deleteschedule"
        ? SQLITE_DENY : SQLITE_OK;
}
static int veto_commit(void*) { return 1; }
static int64_t number(sqlite3* db, const char* query)
{
    sqlite3_stmt* statement = nullptr;
    check(sqlite3_prepare_v2(db, query, -1, &statement, nullptr) == SQLITE_OK, "prepare inspection");
    check(sqlite3_step(statement) == SQLITE_ROW, "step inspection");
    const auto result = sqlite3_column_int64(statement, 0);
    sqlite3_finalize(statement);
    return result;
}
static void seed(sqlite3* db, unsigned count, unsigned schedules, const std::string& layout)
{
    const auto expression = layout == "interleaved"
        ? "2+((rowid-3)%" + std::to_string(schedules) + ")"
        : "2+((rowid-3)*" + std::to_string(schedules) + "/" + std::to_string(count) + ")";
    const std::string query = "BEGIN; WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<"
        + std::to_string(count + 3) + ") INSERT INTO Blocks(rowid,height,header,body,hash) "
          "SELECT x,x,zeroblob(80),zeroblob(1024),printf('%064x',x) FROM n;"
          "INSERT INTO Consensus(height,block_id,history_cursor,account_cursor) VALUES(1,1,0,0);"
          "INSERT INTO State(rowid,address,balance) VALUES(1,x'01',123456);"
          "INSERT INTO History(id,hash,data) VALUES(1,x'01',x'0102');"
          "INSERT INTO AccountHistory(account_id,history_id) VALUES(1,1);"
          "INSERT INTO Deleteschedule(block_id,deletion_key) VALUES(2,0),("
        + std::to_string(count + 3) + "," + std::to_string(schedules + 2) + ");"
          "INSERT INTO Deleteschedule(block_id,deletion_key) SELECT rowid," + expression
        + " FROM Blocks WHERE rowid BETWEEN 3 AND " + std::to_string(count + 2) + "; COMMIT;";
    char* error = nullptr;
    const auto result = sqlite3_exec(db, query.c_str(), nullptr, nullptr, &error);
    const std::string message = error ? error : "seed failed";
    sqlite3_free(error);
    if (result != SQLITE_OK) throw std::runtime_error(message);
}
static void retained(sqlite3* db)
{
    check(number(db, "SELECT count(*) FROM Blocks") == 3, "exact orphan deletion count");
    check(number(db, "SELECT count(*) FROM Deleteschedule") == 2, "protected and future references survive");
    check(number(db, "SELECT count(*) FROM Blocks b JOIN Consensus c ON c.block_id=b.rowid WHERE c.height=1") == 1, "canonical block survives");
    check(number(db, "SELECT count(*) FROM Blocks b JOIN Deleteschedule d ON d.block_id=b.rowid WHERE d.deletion_key=0") == 1, "protected block survives");
    check(number(db, "SELECT balance FROM State WHERE rowid=1") == 123456, "account unchanged");
    check(number(db, "SELECT count(*) FROM History WHERE hex(data)='0102'") == 1, "history unchanged");
    check(number(db, "SELECT count(*) FROM AccountHistory") == 1, "account history unchanged");
    check(number(db, "SELECT integrity_check='ok' FROM pragma_integrity_check") == 1, "database integrity");
}
static void correctness(const std::filesystem::path& path, const std::string& journal, unsigned fault)
{
    ChainDB db(path.string(), journal);
    auto* handle = captured;
    BatchRegistry registry;
    chainserver::Chainstate empty(db, registry);
    chainserver::BlockCache cache;
    auto owned = cache.add_old_chain(empty, DeletionKey(3));
    std::weak_ptr<Headerchain> old = owned;
    owned.reset();
    Access::discard(cache, 2, false);
    const auto before = transactions;
    collect(cache, db);
    check(transactions == before && !old.expired(), "future schedules open no transaction");
    seed(handle, 2, 2, "interleaved");
    // Re-protection after scheduling must still preserve a discarded block.
    check(sqlite3_exec(handle, "UPDATE Deleteschedule SET deletion_key=0 WHERE block_id=3", nullptr, nullptr, nullptr) == SQLITE_OK, "reprotect");
    if (journal == "wal")
        check(sqlite3_wal_checkpoint_v2(handle, nullptr, SQLITE_CHECKPOINT_TRUNCATE, nullptr, nullptr) == SQLITE_OK, "setup checkpoint");
    Access::expire(cache);
    check(Access::pending(cache) == 2, "equal expiration times preserve both schedules");
    Access::discard(cache, 4, false);
    if (fault == 1) sqlite3_set_authorizer(handle, deny_refs, nullptr);
    if (fault == 2) sqlite3_commit_hook(handle, veto_commit, nullptr);
    if (fault >= 3) {
        fault_vfs::remaining = 1;
        fault_vfs::syncFault = fault == 5;
        fault_vfs::partialWrite = fault == 4;
    }
    bool failed = false;
    int errorCode = SQLITE_OK;
    const auto initialDeletes = deletes;
    try { collect(cache, db); }
    catch (const SQLite::Exception& error) { failed = true; errorCode = error.getErrorCode() & 255; }
    sqlite3_set_authorizer(handle, nullptr, nullptr);
    sqlite3_commit_hook(handle, nullptr, nullptr);
    fault_vfs::remaining = -1;
    if (fault) {
        check(failed, "requested delete/commit I/O failure was exercised");
        check(errorCode == (fault == 1 ? SQLITE_AUTH : fault == 2 ? SQLITE_CONSTRAINT : SQLITE_IOERR),
            "failure has the injected SQLite error code");
        check(!old.expired() && Access::pending(cache) == 3, "failed transaction retains all cache ownership and schedules");
        check(number(handle, "SELECT count(*) FROM Blocks") == 5, "failed collection rolls back both deletions");
        check(number(handle, "SELECT count(*) FROM Deleteschedule") == 4, "failed collection retains references");
        collect(cache, db);
    } else {
        check(!failed && deletes - initialDeletes == 2, "one pair of cumulative deletes");
    }
    check(old.expired() && Access::pending(cache) == 1, "committed collection retires only expired cache ownership");
    check(number(handle, "SELECT count(*) FROM Blocks") == 4, "canonical, reprotected, protected and future rows survive");
    check(number(handle, "SELECT count(*) FROM Blocks WHERE rowid IN(1,2,3,5)") == 4, "exact retained identities");
    check(number(handle, "SELECT integrity_check='ok' FROM pragma_integrity_check") == 1, "retry integrity");
    Access::expire(cache);
    collect(cache, db);
    const auto count = transactions;
    collect(cache, db);
    check(transactions == count && Access::pending(cache) == 0, "empty cleanup opens no transaction");
    check(number(handle, "SELECT count(*) FROM Blocks") == 3, "future entry collected at its own expiry");
    std::cout << "RETENTION_OK journal=" << journal << " fault=" << fault << '\n';
}
static json benchmark(const std::filesystem::path& path, const std::string& journal,
    const std::string& layout, unsigned schedules, unsigned count)
{
    ChainDB db(path.string(), journal);
    auto* handle = captured;
    seed(handle, count, schedules, layout);
    if (journal == "wal")
        check(sqlite3_wal_checkpoint_v2(handle, nullptr, SQLITE_CHECKPOINT_TRUNCATE, nullptr, nullptr) == SQLITE_OK, "setup checkpoint");
    chainserver::BlockCache cache;
    for (unsigned i = 0; i < schedules; ++i)
        Access::discard(cache, 2 + i, true, i);
    Access::discard(cache, 2 + schedules, false);
    const auto initialDeletes = deletes;
    const auto cpu = std::clock();
    const auto began = Clock::now();
    collect(cache, db);
    const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - began).count();
    const auto cpuUs = 1000000.0 * (std::clock() - cpu) / CLOCKS_PER_SEC;
    retained(handle);
#ifdef GC_REFERENCE_TRANSACTION
    check(deletes - initialDeletes == 2 * schedules, "reference delete count");
#else
    check(deletes - initialDeletes == 2, "candidate delete count");
#endif
    return {{"elapsed_us", elapsed / 1000.0}, {"cpu_us", cpuUs}, {"deletes", deletes - initialDeletes},
        {"schedules", schedules}, {"rows", count}, {"journal", journal}, {"layout", layout},
        {"synchronous", number(handle, "PRAGMA synchronous")}, {"sqlite", sqlite3_libversion()}};
}
int main(int argc, char** argv) try
{
    check(sqlite3_auto_extension(reinterpret_cast<void(*)()>(observe)) == SQLITE_OK, "test SQL observer");
    fault_vfs::install();
    check(sqlite3_vfs_register(&fault_vfs::wrapper, 1) == SQLITE_OK, "default test VFS");
    const auto directory = std::filesystem::temp_directory_path()
        / ("wart-maintenance-" + std::to_string(Clock::now().time_since_epoch().count()));
    check(std::filesystem::create_directory(directory), "unique disposable directory");
    struct Cleanup { std::filesystem::path path; ~Cleanup() { std::filesystem::remove_all(path); } } cleanup { directory };
    if (argc == 6 && std::string(argv[1]) == "--bench") {
        const std::string journal = argv[2], layout = argv[3];
        const auto schedules = std::stoul(argv[4]), rows = std::stoul(argv[5]);
        check((journal == "wal" || journal == "delete") && (layout == "contiguous" || layout == "interleaved")
            && schedules > 0 && schedules <= rows && rows <= 100000, "invalid benchmark profile");
        std::cout << "MAINTENANCE_RESULT " << benchmark(directory / "bench.db", journal, layout, schedules, rows).dump() << '\n';
    } else {
        check(argc == 1, "usage: db_maintenance [--bench JOURNAL LAYOUT SCHEDULES ROWS]");
        for (const std::string journal : {"delete", "wal"})
            for (unsigned fault = 0; fault < 6; ++fault)
                correctness(directory / (journal + std::to_string(fault) + ".db"), journal, fault);
        std::cout << "maintenance: 12 retention/rollback/retry cases passed (DELETE and WAL)\n";
    }
    sqlite3_vfs_register(fault_vfs::original, 1);
    sqlite3_vfs_unregister(&fault_vfs::wrapper);
    sqlite3_cancel_auto_extension(reinterpret_cast<void(*)()>(observe));
    return 0;
} catch (const std::exception& error) {
    std::cerr << "maintenance failed: " << error.what() << '\n';
    return 1;
}
