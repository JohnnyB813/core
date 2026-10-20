#pragma once

#include "block/block.hpp"
#include "block/header/header_impl.hpp"
#include "crypto/hasher_sha256.hpp"
#include "general/is_testnet.hpp"
#include <algorithm>
#include <map>
#include <optional>
#include <string>
#include <utility>

namespace stratum {
// A job's body and prefix stay together and are never edited by submissions.
class Job {
public:
    explicit Job(Block&& block)
        : block_(std::move(block))
        , prefix_(block_.body_view().merkle_prefix())
    {
    }
    const Block& block() const { return block_; }
    const std::vector<uint8_t>& merkle_prefix() const { return prefix_; }

    Block submission(const std::array<uint8_t, 4>& extra2prefix,
        const std::array<uint8_t, 6>& extranonce2,
        const std::array<uint8_t, 4>& ntime,
        const std::array<uint8_t, 4>& nonce) const
    {
        Block result = block_;
        auto& bytes = result.body.data();
        std::copy(extra2prefix.begin(), extra2prefix.end(), bytes.begin());
        std::copy(extranonce2.begin(), extranonce2.end(), bytes.begin() + 4);
        // Stratum templates use the ten-byte seed format. Keep historical
        // root algorithms on their existing path if a legacy job is supplied.
        if (is_testnet() || (result.height.value() >= NEWBLOCKSTRUCUTREHEIGHT
                               && result.height.value() >= NEWMERKLEROOT)) {
            HasherSHA256 hasher;
            hasher.write(prefix_.data(), prefix_.size());
            hasher.write(bytes.data(), 10);
            Hash root = std::move(hasher);
            result.header.set_merkleroot(root);
        } else {
            result.header.set_merkleroot(result.body_view().merkle_root(result.height));
        }
        result.header.set_nonce(nonce);
        result.header.set_timestamp(ntime);
        return result;
    }

private:
    Block block_;
    std::vector<uint8_t> prefix_;
};

class JobCache {
public:
    void clear()
    {
        blocks.clear();
        latestJobId.reset();
    }

    const Job* find(const std::string& jobId) const
    {
        auto iter = blocks.find(jobId);
        return iter == blocks.end() ? nullptr : &iter->second;
    }

    const std::map<std::string, Job>::value_type* latest() const
    {
        if (!latestJobId)
            return nullptr;
        return &*blocks.find(*latestJobId);
    }

    const Job* add(const std::string& jobId, Block&& block)
    {
        if (!blocks.empty() && blocks.begin()->second.block().header.prevhash() != block.header.prevhash())
            clear();

        auto [iter, inserted] = blocks.try_emplace(jobId, std::move(block));
        if (!inserted)
            return nullptr;
        // Job IDs are hashes; their sort order is unrelated to arrival order.
        latestJobId = jobId;
        return &iter->second;
    }

private:
    std::map<std::string, Job> blocks;
    std::optional<std::string> latestJobId;
};
}
