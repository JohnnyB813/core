// This file and the profile's Stratum translation unit are compiled with
// put_chain_append renamed. All validation and the normal append remain intact.
#include "api/interface.hpp"
#include "communication/mining_task.hpp"
#include "general/latency.hpp"
#include <iostream>
#include <stdexcept>
#undef put_chain_append
void put_chain_append(ChainMiningTask&&, ResultCb);

void profile_chain_append(ChainMiningTask&& task, ResultCb callback)
{
    if (!task.block.trace || task.block.trace->createdAt == latency::TimePoint {})
        throw std::runtime_error("submission profile requires latency diagnostics");
    const auto us = latency::microseconds(task.block.trace->createdAt, latency::Clock::now());
    put_chain_append(std::move(task), [callback = std::move(callback), us](const auto& result) {
        // Report preparation only for blocks that passed every ordinary check
        // and committed successfully, immediately before the ordinary reply.
        if (result.has_value()) std::cout << "STRATUM_ACCEPTED_PREPARATION_US " << us << std::endl;
        callback(result);
    });
}
