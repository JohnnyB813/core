// Socket-test helper. Publishes through the node's private/public dispatch path.
#include "api/http/endpoint.hpp"
#include "api/http/json.hpp"
#include "block/header/header_impl.hpp"
#include "general/hex.hpp"
#include "global/globals.hpp"
#include <atomic>
#include <fstream>
#include <iostream>
#include <optional>
#include <stdexcept>

using json = nlohmann::json;
static std::atomic<unsigned> blockFormats { 0 }, rollbackFormats { 0 };
#ifdef COUNT_WEBSOCKET_FORMATS
extern "C" json __real__ZN7jsonmsg7to_jsonB5cxx11ERKN3API5BlockE(const API::Block&);
extern "C" json __wrap__ZN7jsonmsg7to_jsonB5cxx11ERKN3API5BlockE(const API::Block& block)
{
    ++blockFormats;
    return __real__ZN7jsonmsg7to_jsonB5cxx11ERKN3API5BlockE(block);
}
extern "C" json __real__ZN7jsonmsg7to_jsonB5cxx11ERKN3API8RollbackE(const API::Rollback&);
extern "C" json __wrap__ZN7jsonmsg7to_jsonB5cxx11ERKN3API8RollbackE(const API::Rollback& rollback)
{
    ++rollbackFormats;
    return __real__ZN7jsonmsg7to_jsonB5cxx11ERKN3API8RollbackE(rollback);
}
#endif

int main(int argc, char** argv) try
{
    if (argc != 2 && (argc != 3 || std::string_view(argv[2]) != "dual"))
        throw std::runtime_error("expected public block fixture and optional dual mode");
    json fixture;
    std::ifstream(argv[1]) >> fixture;
    const Header header(hex_to_arr<80>(fixture["blocks"][0][1].get<std::string>()));
    const Address address(std::array<uint8_t, 20> {});
    const bool dual = argc == 3;
    HTTPEndpoint endpoint(EndpointAddress(dual ? "127.0.0.1:34210" : "127.0.0.1:34200"), false, HTTPEndpoint::StartMode::Deferred);
    std::optional<HTTPEndpoint> endpointPublic;
    if (argc == 3)
        endpointPublic.emplace(EndpointAddress("127.0.0.1:34211"), true, HTTPEndpoint::StartMode::Deferred);
    global_init(nullptr, nullptr, nullptr, nullptr, nullptr, &endpoint,
        endpointPublic ? &*endpointPublic : nullptr);
    endpoint.start();
    if (endpointPublic) endpointPublic->start();
    std::string line;
    while (std::getline(std::cin, line)) {
        const auto command = json::parse(line);
        const auto type = command.at("event").get<std::string>();
        if (type == "quit") break;
        if (type == "append") {
            API::Block block(header, NonzeroHeight(command.at("height").get<unsigned>()), 1);
            for (unsigned i = 0; i < command.value("transfers", 0u); ++i) {
                block.transfers.push_back({ address, Funds::from_value_throw(1), NonceId(i), PinHeight(Height(0)),
                    Hash::genesis(), address, Funds::from_value_throw(10) });
            }
            publish_websocket_event(std::move(block));
        } else if (type == "rollback") {
            publish_websocket_event(API::Rollback { Height(command.at("height").get<unsigned>()) });
        } else if (type == "reset") {
            blockFormats = 0;
            rollbackFormats = 0;
        }
        std::cout << "COUNTS " << json { { "blocks", blockFormats.load() },
            { "rollbacks", rollbackFormats.load() },
#ifdef COUNT_WEBSOCKET_FORMATS
            { "instrumented", true }
#else
            { "instrumented", false }
#endif
        } << std::endl;
    }
} catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
}
