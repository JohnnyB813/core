#include "api/stratum/stratum_server.hpp"
#include "chainserver/server.hpp"
#include "db/chain_db.hpp"
#include "general/is_testnet.hpp"
#include "global/globals.hpp"
#include "nlohmann/json.hpp"
#include "stratum_fixture.hpp"
#include <ctime>
#include <filesystem>
#include <iostream>
#include <string>
#ifdef __linux__
#include <sys/resource.h>
#endif

int main(int argc, char** argv)
{
    try {
        if (argc != 4) throw std::runtime_error("usage: stratum_fanout PORT PAYOUTS TRANSFERS");
        const auto port = std::stoul(argv[1]);
        const auto payouts = std::stoul(argv[2]);
        const auto transfers = std::stoul(argv[3]);
        if (port < 1024 || port > 65535 || payouts == 0 || payouts > 256 || transfers > 300)
            throw std::runtime_error("invalid fixture bounds");
        enable_testnet();
        spdlog::set_level(spdlog::level::warn);
        ECC_Start();
        struct StopECC { ~StopECC() { ECC_Stop(); } } stopECC;
        std::filesystem::create_directories(config().defaultDataDir + "logs_testnet");
        ChainDB database("");
        BatchRegistry registry;
        std::vector<std::pair<Address, Block>> templates;
        nlohmann::json metadata = nlohmann::json::array();
        for (size_t i = 0; i < payouts; ++i) {
            const auto address = stratum_fixture::address(i + 1);
            auto block = stratum_fixture::block(address, transfers);
            metadata.push_back({ { "address", address.to_string() },
                { "header", serialize_hex(block.header) }, { "body", serialize_hex(block.body.data()) } });
            templates.emplace_back(address, std::move(block));
        }
        auto chain = ChainServer::make_chain_server(database, registry, {});
        struct StopChain {
            std::shared_ptr<ChainServer> chain;
            ~StopChain() { chain->shutdown_join(); }
        } stopChain { chain };
        global_init(&registry, nullptr, chain.get(), nullptr, nullptr, nullptr);
        StratumServer server(EndpointAddress("127.0.0.1:" + std::to_string(port)));
        std::cout << nlohmann::json { { "ready", true }, { "templates", metadata } }.dump() << std::endl;
        std::clock_t started = 0;
        for (std::string command; std::cin >> command;) {
            if (command == "start") {
                started = std::clock();
                std::cout << "{\"started\":true}" << std::endl;
            } else if (command == "stop") {
                const auto cpu = 1000000.0 * (std::clock() - started) / CLOCKS_PER_SEC;
                long peakRss = 0;
#ifdef __linux__
                rusage usage {};
                if (getrusage(RUSAGE_SELF, &usage) == 0) peakRss = usage.ru_maxrss;
#endif
                std::cout << nlohmann::json { { "cpu_us", cpu }, { "peak_rss_kib", peakRss } }.dump() << std::endl;
            } else if (command == "job") {
                uint64_t sequence;
                if (!(std::cin >> sequence)) throw std::runtime_error("missing job sequence");
                for (const auto& [address, original] : templates) {
                    auto block = original;
                    for (size_t i = 0; i < 8; ++i)
                        block.header[i] = uint8_t(sequence >> (8 * (7 - i)));
                    server.on_mining_task(address, ChainMiningTask { .block = std::move(block) });
                }
            } else if (command == "quit") {
                break;
            } else {
                throw std::runtime_error("unknown fixture command");
            }
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
    } catch (Error error) {
        std::cerr << error.strerror() << '\n';
    }
    return 1;
}
