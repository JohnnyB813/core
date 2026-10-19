#include "db/journal.hpp"
#include <filesystem>
#include <chrono>
#include <iostream>

static void check(bool value, const char* what) { if (!value) throw std::runtime_error(what); }
int main()
{
    auto dir = std::filesystem::temp_directory_path() / ("warthog-journal-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    check(std::filesystem::create_directory(dir), "unique test directory");
    auto path = (dir / "test.db").string();
    try {
        {
            SQLite::Database db(path, SQLite::OPEN_READWRITE | SQLite::OPEN_CREATE);
            ChainJournal settings(db, path, "wal");
            check(settings.effective == "wal", "new database enters WAL");
            db.exec("CREATE TABLE state(id INTEGER PRIMARY KEY, balance INTEGER NOT NULL)");
            { SQLite::Transaction tx(db); db.exec("INSERT INTO state VALUES(1,100)"); tx.commit(); }
            { SQLite::Transaction tx(db); db.exec("UPDATE state SET balance=0"); }
            check(db.execAndGet("SELECT balance FROM state").getInt() == 100, "uncommitted write rolled back");
            // Force frequent checkpoints in this test, keeping the production threshold at 1000.
            db.exec("PRAGMA wal_autocheckpoint=1");
            for (int i = 0; i < 20; ++i) db.exec("UPDATE state SET balance=balance+1");
        }
        {
            SQLite::Database db(path, SQLite::OPEN_READWRITE);
            check(db.execAndGet("PRAGMA journal_mode").getString() == "wal", "WAL persists after restart");
            ChainJournal settings(db, path, "delete");
            check(settings.effective == "delete", "WAL converts back to DELETE");
            check(db.execAndGet("SELECT balance FROM state").getInt() == 120, "conversion preserves committed state");
            check(db.execAndGet("PRAGMA integrity_check").getString() == "ok", "database integrity");
            ChainJournal wal(db, path, "wal");
            SQLite::Database reader(path, SQLite::OPEN_READWRITE);
            reader.exec("BEGIN");
            reader.execAndGet("SELECT balance FROM state");
            bool refused = false;
            try { ChainJournal blocked(db, path, "delete"); } catch (const std::exception& error) {
                refused = std::string(error.what()).find("journal_mode=delete") != std::string::npos;
            }
            check(refused, "busy mode conversion fails rather than silently falling back");
            reader.exec("ROLLBACK");
        }
        {
            SQLite::Database temporary("", SQLite::OPEN_READWRITE | SQLite::OPEN_CREATE);
            ChainJournal settings(temporary, "", "wal");
            check(temporary.execAndGet("PRAGMA synchronous").getInt() == 2, "temporary database keeps FULL");
            temporary.exec("CREATE TABLE data(id)");
        }
        std::filesystem::remove_all(dir);
        std::cout << "durable journal modes passed\n";
    } catch (...) { std::filesystem::remove_all(dir); throw; }
}
