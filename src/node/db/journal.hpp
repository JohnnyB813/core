#pragma once
#include "SQLiteCpp/SQLiteCpp.h"
#include <stdexcept>
#include <string>

// Run after the application's file lock, before any schema writes or statements.
struct ChainJournal {
    std::string effective;
    ChainJournal(SQLite::Database& db, const std::string& path, const std::string& requested)
    {
        if (requested != "wal" && requested != "delete")
            throw std::runtime_error("Invalid chain database journal: " + requested);
        const auto mode = path.empty() ? "delete" : requested;
        try {
            effective = db.execAndGet("PRAGMA journal_mode=" + mode).getString();
        } catch (const std::exception& error) {
            throw std::runtime_error("Cannot configure chain database journal_mode=" + mode + ": " + error.what());
        }
        if (!path.empty() && effective != requested)
            throw std::runtime_error("Chain database cannot enter journal_mode=" + requested
                + " (effective=" + effective + "). Use --chain-db-journal=delete on storage without WAL support.");
        db.exec("PRAGMA synchronous=FULL");
        db.exec("PRAGMA foreign_keys=ON");
        db.exec("PRAGMA wal_autocheckpoint=1000");
        if (db.execAndGet("PRAGMA synchronous").getInt() != 2
            || db.execAndGet("PRAGMA foreign_keys").getInt() != 1
            || db.execAndGet("PRAGMA wal_autocheckpoint").getInt() != 1000)
            throw std::runtime_error("Cannot establish durable chain database settings");
    }
};
