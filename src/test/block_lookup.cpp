#include "block/header/header_impl.hpp"
#include "db/chain_db.hpp"
#include "general/hex.hpp"
#include "nlohmann/json.hpp"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>

static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}
static Block block_from(const nlohmann::json& row)
{
    return { NonzeroHeight(row.at(0).get<uint32_t>()), Header(hex_to_arr<80>(row.at(1).get<std::string>())),
        BodyContainer(hex_to_vec(row.at(2).get<std::string>())), {} };
}
static void verify(ChainDB& db, const std::vector<std::pair<BlockId, Block>>& inserted)
{
    for (const auto& [id, expected] : inserted) {
        const auto byId = db.get_block(id);
        const auto byHash = db.get_block(expected.header.hash());
        check(byId && *byId == expected, "row-ID lookup retains block metadata and bytes");
        check(byHash && byHash->first == id, "hash lookup returns row ID separately");
        if (byHash->second.height != expected.height)
            throw std::runtime_error("hash lookup height: expected=" + std::to_string(expected.height.value())
                + " actual=" + std::to_string(byHash->second.height.value()));
        check(byHash->second == expected, "both lookup paths return identical blocks");
        check(db.lookup_block_height(expected.header.hash()) == expected.height, "height-only lookup agrees");
    }
    check(!db.get_block(BlockId(uint64_t(10000))), "missing row ID");
    Hash missing; missing.fill(0x42);
    check(!db.get_block(missing), "missing hash");
}
static void one(const std::string& path, const std::string& mode, const nlohmann::json& fixture)
{
    std::vector<std::pair<BlockId, Block>> inserted;
    {
        ChainDB db(path, mode);
        {
            auto transaction = db.transaction();
            // Genuine recorded blocks, deliberately stored out of height order.
            // This tests database lookup, not chain acceptance.
            for (const unsigned index : {2u, 0u, 1u}) {
                auto block = block_from(fixture.at("blocks").at(index));
                const auto [id, fresh] = db.insert_protect(block);
                check(fresh && id.value() != block.height.value(), "fixture separates height from row ID");
                inserted.emplace_back(id, std::move(block));
            }
            verify(db, inserted);
            auto conflicting = inserted.front().second;
            conflicting.body.data().front() ^= 1;
            const auto [id, fresh] = db.insert_protect(conflicting);
            check(!fresh && id == inserted.front().first, "duplicate header reuses existing row");
            verify(db, inserted);
            transaction.commit();
        }
        verify(db, inserted);
        if (path.empty()) return;
    }
    {
        ChainDB reopened(path, mode);
        verify(reopened, inserted);
    }
    {
        SQLite::Database inspect(path, SQLite::OPEN_READWRITE);
        inspect.exec("UPDATE Blocks SET height=0 WHERE rowid=" + std::to_string(inserted.front().first.value()));
    }
    {
        ChainDB corrupted(path, mode);
        for (const bool byHash : {false, true}) {
            bool refused = false;
            try {
                if (byHash) (void)corrupted.get_block(inserted.front().second.header.hash());
                else (void)corrupted.get_block(inserted.front().first);
            } catch (const std::runtime_error& error) {
                refused = std::string(error.what()).find("height 0") != std::string::npos;
            }
            check(refused, "both lookup paths reject zero stored height");
        }
    }
}
int main(int argc, char** argv) try
{
    check(argc == 2, "public recorded fixture path required");
    std::ifstream input(argv[1]); nlohmann::json fixture; input >> fixture;
    check(fixture.at("base_height") == 0 && fixture.at("blocks").size() >= 3, "genesis fixture required");
    const auto directory = std::filesystem::temp_directory_path()
        / ("wart-block-lookup-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    check(std::filesystem::create_directory(directory), "unique test directory");
    struct Cleanup { std::filesystem::path path; ~Cleanup() { std::filesystem::remove_all(path); } } cleanup { directory };
    one("", "delete", fixture);
    one((directory / "delete.db").string(), "delete", fixture);
    one((directory / "wal.db").string(), "wal", fixture);
    std::cout << "block lookup: divergent row IDs, duplicates, restart and zero-height rejection passed\n";
    return 0;
} catch (const std::exception& error) {
    std::cerr << "block lookup failed: " << error.what() << '\n';
    return 1;
}
