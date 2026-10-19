#pragma once

#include "block/block.hpp"
#include "block/header/header_impl.hpp"
#include <map>
#include <optional>
#include <string>
#include <utility>

namespace stratum {
class JobCache {
public:
    void clear()
    {
        blocks.clear();
        latestJobId.reset();
    }

    Block* find(const std::string& jobId)
    {
        auto iter = blocks.find(jobId);
        return iter == blocks.end() ? nullptr : &iter->second;
    }

    const std::map<std::string, Block>::value_type* latest() const
    {
        if (!latestJobId)
            return nullptr;
        return &*blocks.find(*latestJobId);
    }

    Block* add(const std::string& jobId, Block&& block)
    {
        if (!blocks.empty() && blocks.begin()->second.header.prevhash() != block.header.prevhash())
            clear();

        auto [iter, inserted] = blocks.try_emplace(jobId, std::move(block));
        if (!inserted)
            return nullptr;
        // Job IDs are hashes; their sort order is unrelated to arrival order.
        latestJobId = jobId;
        return &iter->second;
    }

private:
    std::map<std::string, Block> blocks;
    std::optional<std::string> latestJobId;
};
}
