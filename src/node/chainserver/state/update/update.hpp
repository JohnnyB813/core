#pragma once
#include "chainstate_update.hpp"
#include "mempool_update.hpp"
#include "stage_update.hpp"
#include "general/latency.hpp"

namespace chainserver {
namespace state_update {

    struct StateUpdate {
        ChainstateUpdate chainstateUpdate;
        MempoolUpdate mempoolUpdate;
        latency::TracePtr trace {};
        latency::TimePoint queuedAt {};
    };

}
}
