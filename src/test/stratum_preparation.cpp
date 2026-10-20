#include "api/stratum/stratum_server.hpp"
#include "general/is_testnet.hpp"
#include "nlohmann/json.hpp"
#include "stratum_fixture.hpp"
#include <iostream>
#include <stdexcept>

static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}

int main()
{
    enable_testnet();
    for (size_t transactions : { 0u, 100u, 300u }) {
        for (size_t payout : { 1u, 2u }) {
            const auto block = stratum_fixture::block(stratum_fixture::address(payout), transactions);
            const auto bodyBefore = block.body.data();
            const auto headerBefore = block.header;
            const auto jobId = serialize_hex(block.header.hash());
            nlohmann::json previous;
            for (bool clean : { false, true }) {
                const auto lines = stratum::prepare_work(jobId, block, clean);
                const auto separator = lines.find('\n');
                check(separator != std::string::npos && lines.find('\n', separator + 1) == std::string::npos,
                    "work must contain exactly difficulty and notification lines");
                const auto difficulty = nlohmann::json::parse(lines.substr(0, separator));
                auto notify = nlohmann::json::parse(lines.substr(separator + 1));
                check(difficulty.at("method") == "mining.set_difficulty" && difficulty.at("id").is_null(),
                    "difficulty message format");
                check(difficulty.at("params").at(0) == block.header.target_v2().difficulty(), "difficulty value");
                check(notify.at("method") == "mining.notify" && notify.at("id").is_null(), "notification format");
                const auto& params = notify.at("params");
                check(params.size() == 7 && params.at(0) == jobId, "job identity");
                check(params.at(1) == serialize_hex(block.header.prevhash()), "previous hash");
                check(params.at(2) == serialize_hex(block.body_view().merkle_prefix()), "payout/template prefix");
                check(params.at(3) == serialize_hex(block.header.version()), "version byte order");
                check(params.at(4) == serialize_hex(hton32(block.header.target_v2().binary())), "target byte order");
                check(params.at(5) == serialize_hex(block.header.timestamp()), "timestamp byte order");
                check(params.at(6) == clean, "clean flag");
                notify["params"][6] = false;
                if (clean) check(notify == previous, "flag variants changed other job fields");
                previous = std::move(notify);
                check(block.body.data() == bodyBefore && block.header == headerBefore, "preparation mutated cached work");
            }
        }
    }
    std::cout << "Stratum work preparation: flag variants, template fields, and immutability passed\n";
}
