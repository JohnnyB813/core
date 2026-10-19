#pragma once

#include "block/block.hpp"

struct ChainMiningTask {
    Block block;
    latency::TracePtr parentTrace {};
    latency::TimePoint queuedAt {};
};
