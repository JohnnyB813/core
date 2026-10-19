#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <deque>

// Local diagnostics only: none of these fields are serialized on the network.
namespace latency {
using Clock = std::chrono::steady_clock;
using TimePoint = Clock::time_point;
enum class Mode { Off, Summary, Detail };
enum class Phase : size_t {
    Request, ReceiveQueue, EventQueue, ChainQueue, HeaderBody, DownloadChecks,
    TransactionValidation, DatabaseWrite, Commit, StatePublication, StateQueue,
    MiningTemplate, StratumQueue, MinerWriteQueued, PeerAnnouncementQueued,
    GarbageCollection, StageSet, BlockApply, SubmissionToAccept, MinerLastWriteQueued, StageApply, ReceiveToAccept, Count
};
enum class Outcome { None, Accepted, Staged, Stale, Rejected, TimedOut };
constexpr size_t phaseCount = size_t(Phase::Count);
constexpr std::array<std::string_view, phaseCount> phaseNames {
    "block_response", "receive_queue", "event_queue", "chain_queue", "header_body_checks",
    "download_checks", "transaction_validation", "database_write", "commit_including_checkpoint",
    "state_publication", "state_queue", "mining_template", "stratum_queue",
    "accept_to_miner_write_queued", "accept_to_peer_announcement_queued", "garbage_collection",
    "stage_set", "block_apply", "submission_to_accept", "accept_to_last_miner_write_queued", "stage_apply_including_commit", "receive_to_accept"
};
constexpr std::array<std::string_view, 6> outcomeNames { "none", "accepted", "staged", "stale", "rejected", "timed_out" };
inline uint64_t microseconds(TimePoint start, TimePoint end)
{
    return end > start ? uint64_t(std::chrono::duration_cast<std::chrono::microseconds>(end - start).count()) : 0;
}
struct Record {
    uint64_t id = 0;
    uint32_t height = 0;
    std::array<uint8_t, 32> hash {};
    uint64_t peer = 0;
    uint32_t batchSize = 1;
    Outcome outcome = Outcome::None;
    std::array<uint64_t, phaseCount> us {};
    uint64_t present = 0;
};
class RecordQueue {
    std::deque<Record> records;
public:
    static constexpr size_t capacity = 1024;
    uint64_t dropped = 0;
    void push(Record r)
    {
        if (records.size() == capacity) { records.pop_front(); ++dropped; }
        records.push_back(std::move(r));
    }
    bool empty() const { return records.empty(); }
    std::deque<Record> drain() { std::deque<Record> out; out.swap(records); return out; }
};
void submit(Record) noexcept;
bool enabled() noexcept;
void sample(Phase, uint64_t us) noexcept;
struct Trace {
    Record identity;
    std::array<std::atomic<uint64_t>, phaseCount> us {};
    std::atomic<uint64_t> present { 0 };
    std::atomic<Outcome> outcome { Outcome::None };
    std::atomic<int64_t> acceptedNs { 0 };
    std::atomic<int64_t> receivedNs { 0 };
    TimePoint createdAt { Clock::now() };
    explicit Trace(Record r) : identity(std::move(r)) {}
    ~Trace();
    void add(Phase p, uint64_t value) noexcept
    {
        us[size_t(p)].fetch_add(value, std::memory_order_relaxed);
        present.fetch_or(uint64_t(1) << size_t(p), std::memory_order_relaxed);
    }
    void accept(TimePoint now = Clock::now()) noexcept;
    void milestone(Phase p, TimePoint now = Clock::now()) noexcept;
    void observe_once(Phase p, uint64_t value) noexcept
    {
        auto bit = uint64_t(1) << size_t(p);
        if (!(present.fetch_or(bit) & bit)) us[size_t(p)].store(value);
    }
    void latest_milestone(Phase p, TimePoint now = Clock::now()) noexcept;
};
using TracePtr = std::shared_ptr<Trace>;
TracePtr make_trace(uint32_t height, std::span<const uint8_t, 32> hash, uint64_t peer = 0, uint32_t batchSize = 1) noexcept;
inline thread_local TracePtr current;
inline thread_local std::span<const TracePtr> currentGroup;
struct Context {
    TracePtr previous;
    explicit Context(TracePtr trace) : previous(std::move(current)) { current = std::move(trace); }
    ~Context() { current = std::move(previous); }
};
struct Group {
    std::span<const TracePtr> previous;
    explicit Group(std::span<const TracePtr> traces) : previous(currentGroup) { currentGroup = traces; }
    ~Group() { currentGroup = previous; }
};
inline TracePtr for_height(uint32_t height)
{
    for (const auto& trace : currentGroup)
        if (trace && trace->identity.height == height) return trace;
    return {};
}
class Scope {
    Phase phase;
    TracePtr trace;
    TimePoint start;
    bool active;
public:
    explicit Scope(Phase phase) : phase(phase), trace(current), active(enabled())
    { if (active) start = Clock::now(); }
    ~Scope() { finish(); }
    void finish()
    {
        if (!active) return;
        active = false;
        auto us = microseconds(start, Clock::now());
        if (trace) trace->add(phase, us); else sample(phase, us);
    }
    Scope(const Scope&) = delete;
};
// Envelopes preserve FIFO order while measuring actual enqueue-to-dispatch time.
template <typename T> struct Queued {
    T event;
    TimePoint queuedAt;
    template <typename U> explicit Queued(U&& value)
        : event(std::forward<U>(value)), queuedAt(enabled() ? Clock::now() : TimePoint {}) {}
};
class Runtime {
public:
    struct Impl;
private:
    std::unique_ptr<Impl> impl;
public:
    Runtime(Mode, const std::string& directory);
    ~Runtime();
    Runtime(const Runtime&) = delete;
};
}
