#pragma once
#include "general/latency.hpp"
#include <optional>
#include <span>
#include <tuple>

namespace BlockDownload {
struct PeerLatency {
    struct Average {
        std::optional<uint64_t> us;
        latency::TimePoint updated {};
        std::chrono::seconds maxGap;
        explicit Average(std::chrono::seconds maxGap = std::chrono::seconds(120)) : maxGap(maxGap) {}
        void add(uint64_t sample, latency::TimePoint now)
        {
            us = us && now >= updated && now - updated <= maxGap ? (*us * 7 + sample) / 8 : sample;
            updated = now;
        }
        std::optional<uint64_t> fresh(latency::TimePoint now, std::chrono::seconds ttl) const
        { return us && now >= updated && now - updated <= ttl ? us : std::nullopt; }
    } block, ping {std::chrono::seconds(30)};
    uint64_t lastSelected = 0;
    auto score(latency::TimePoint now) const
    {
        auto result = block.fresh(now, std::chrono::seconds(120));
        return result ? result : ping.fresh(now, std::chrono::seconds(30));
    }
    void observe_block(bool accepted, bool expired, size_t blocks, latency::TimePoint sent, latency::TimePoint received)
    {
        if (accepted && !expired && blocks == 1 && received >= sent)
            block.add(latency::microseconds(sent, received), received);
    }
};
struct PeerCandidate {
    uint64_t id;
    PeerLatency* latency;
};
class PeerSelector {
    uint64_t selections = 0;
public:
    // Call with the existing fork-qualified, non-busy candidates, in legacy order.
    size_t select(std::span<const PeerCandidate> peers, latency::TimePoint now)
    {
        if (peers.empty()) return 0;
        ++selections;
        bool anyMeasured = false;
        for (const auto& peer : peers) anyMeasured |= peer.latency->score(now).has_value();
        size_t best = 0;
        if (anyMeasured) {
            const bool explore = selections % 32 == 0;
            auto key = [&](const PeerCandidate& p) {
                auto score = p.latency->score(now);
                return std::tuple(explore ? false : !score.has_value(),
                    explore ? uint64_t(0) : score.value_or(0), p.latency->lastSelected, p.id);
            };
            for (size_t i = 1; i < peers.size(); ++i)
                if (key(peers[i]) < key(peers[best])) best = i;
        }
        peers[best].latency->lastSelected = selections;
        return best;
    }
};
}
