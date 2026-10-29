#pragma once
#include "config/config.hpp"
#include "general/logging.hpp"
#include <memory>

class BatchRegistry;
class HTTPEndpoint;
class PeerServer;
class ChainServer;
class Eventloop;
class Conman;
namespace API {
struct Block;
struct Rollback;
}
namespace spdlog {
class logger;
}

struct Global {
    ChainServer* pcs;
    PeerServer* pps;
    Conman* pcm;
    Eventloop* pel;
    BatchRegistry* pbr;
    HTTPEndpoint* httpEndpoint;
    HTTPEndpoint* publicHttpEndpoint;
    std::shared_ptr<spdlog::logger> connLogger;
    std::optional<logging::TimingLogger> timingLogger;
    std::shared_ptr<spdlog::logger> syncdebugLogger;
    Config conf;
};

const Global& global();
HTTPEndpoint& http_endpoint();
void publish_websocket_event(API::Block);
void publish_websocket_event(API::Rollback);
inline spdlog::logger& connection_log() { return *global().connLogger; }
inline auto& timing_log() { return global().timingLogger.value(); }
inline spdlog::logger& syncdebug_log() { return *global().syncdebugLogger; }
const Config& config();
Config& set_config();
int init_config(int argc, char** argv);
void global_init(BatchRegistry* pbr, PeerServer* pps, ChainServer* pcs, Conman* pcm, Eventloop* pel, HTTPEndpoint* httpEndpoint, HTTPEndpoint* publicHttpEndpoint = nullptr);
