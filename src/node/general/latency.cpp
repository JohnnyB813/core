#include "general/latency.hpp"
#include "spdlog/spdlog.h"
#include "spdlog/sinks/rotating_file_sink.h"
#include <algorithm>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <mutex>
#include <sstream>
#include <thread>

namespace latency {
namespace {
std::atomic<uint64_t> sequence { 1 };
std::atomic<size_t> liveTraces { 0 };
std::atomic<uint64_t> skippedRecords { 0 };
struct Histogram {
    std::array<uint64_t, 2001> bins {};
    uint64_t count = 0;
    void add(uint64_t us) { ++bins[std::min(us / 1000, uint64_t(2000))]; ++count; }
    uint64_t percentile(unsigned p) const
    {
        if (!count) return 0;
        auto target = (count * p + 99) / 100;
        uint64_t seen = 0;
        for (size_t i = 0; i < bins.size(); ++i) {
            seen += bins[i];
            if (seen >= target) return (i + 1) * 1000;
        }
        return 2001000;
    }
};
std::string hex(const std::array<uint8_t,32>& bytes)
{
    static constexpr char digits[] = "0123456789abcdef";
    std::string result(64, '0');
    for (size_t i = 0; i < bytes.size(); ++i) { result[2*i] = digits[bytes[i] >> 4]; result[2*i+1] = digits[bytes[i] & 15]; }
    return result;
}
}
struct Runtime::Impl {
    Mode mode;
    std::mutex mutex;
    std::condition_variable cv;
    RecordQueue queue;
    bool closing = false;
    std::shared_ptr<spdlog::logger> logger;
    std::thread worker;
    explicit Impl(Mode mode, const std::string& directory) : mode(mode)
    {
        if (mode == Mode::Detail) {
            std::filesystem::create_directories(directory);
            logger = std::make_shared<spdlog::logger>("latency", std::make_shared<spdlog::sinks::rotating_file_sink_mt>(directory + "/latency.log", 5 * 1024 * 1024, 3));
        }
        worker = std::thread([this] { run(); });
    }
    void push(Record r) noexcept
    {
        try {
            std::lock_guard lock(mutex);
            queue.push(std::move(r));
            cv.notify_one();
        } catch (...) { skippedRecords.fetch_add(1); }
    }
    void run() noexcept
    {
        try {
            // musl's default worker-thread stack is small. Keep bounded histogram
            // storage on the heap, not on the network/consensus or logger stack.
            auto histogramStorage = std::make_unique<std::array<std::array<Histogram, phaseCount>, outcomeNames.size()>>();
            auto& histograms = *histogramStorage;
            std::array<uint64_t, outcomeNames.size()> outcomes {};
            std::array<uint64_t, outcomeNames.size()> requestOutcomes {};
            const auto boot = std::chrono::system_clock::now().time_since_epoch().count();
            auto next = Clock::now() + std::chrono::seconds(60);
            for (;;) {
                std::deque<Record> work;
                bool stop;
                uint64_t lost;
                {
                    std::unique_lock lock(mutex);
                    cv.wait_until(lock, next, [&] { return closing || !queue.empty(); });
                    work = queue.drain();
                    stop = closing;
                    lost = queue.dropped + skippedRecords.load();
                }
                for (const auto& record : work) {
                    if (record.outcome != Outcome::None) {
                        if (record.id) ++outcomes[size_t(record.outcome)];
                        else ++requestOutcomes[size_t(record.outcome)];
                    }
                    std::ostringstream line;
                    if (logger) line << "boot=" << boot << " kind=" << (record.id ? "block" : record.outcome == Outcome::None ? "phase" : "request") << " trace=" << record.id << " height=" << record.height << " hash=" << hex(record.hash)
                                     << " peer=" << record.peer << " batch=" << record.batchSize << " outcome=" << outcomeNames[size_t(record.outcome)];
                    for (size_t i = 0; i < phaseCount; ++i) {
                        if (!(record.present & (uint64_t(1) << i))) continue;
                        histograms[size_t(record.outcome)][i].add(record.us[i]);
                        if (logger) line << ' ' << phaseNames[i] << "_us=" << record.us[i];
                    }
                    if (logger) logger->info("{}", line.str());
                }
                if (Clock::now() >= next || stop) {
                    std::ostringstream line;
                    line << "Latency summary (percentiles rounded up to 1ms; >=2000ms in overflow bin): dropped=" << lost;
                    for (size_t i = 1; i < outcomes.size(); ++i)
                        line << " block_" << outcomeNames[i] << '=' << outcomes[i] << " request_" << outcomeNames[i] << '=' << requestOutcomes[i];
                    for (size_t outcome = 0; outcome < outcomeNames.size(); ++outcome) for (size_t i = 0; i < phaseCount; ++i) {
                        auto& h = histograms[outcome][i];
                        if (h.count) {
                            auto p50 = h.percentile(50), p95 = h.percentile(95);
                            line << ' ' << outcomeNames[outcome] << '.' << phaseNames[i] << "[n=" << h.count
                                 << ",p50_us" << (p50 >= 2001000 ? ">=" : "<=") << (p50 >= 2001000 ? 2000000 : p50)
                                 << ",p95_us" << (p95 >= 2001000 ? ">=" : "<=") << (p95 >= 2001000 ? 2000000 : p95) << ']';
                        }
                    }
                    spdlog::info("{}", line.str());
                    for (auto& outcome : histograms) for (auto& histogram : outcome) { histogram.bins.fill(0); histogram.count = 0; }
                    outcomes = {};
                    requestOutcomes = {};
                    next = Clock::now() + std::chrono::seconds(60);
                }
                if (stop) { if (logger) logger->flush(); return; }
            }
        } catch (...) { /* Logging failures cannot stop consensus processing. */ }
    }
    ~Impl()
    {
        { std::lock_guard lock(mutex); closing = true; cv.notify_one(); }
        worker.join();
    }
};
// Runtime is constructed before node workers and destroyed after they are joined.
namespace { std::atomic<void*> runtime { nullptr }; }
void push_record(void* p, Record r) noexcept { static_cast<Runtime::Impl*>(p)->push(std::move(r)); }
bool enabled() noexcept { return runtime.load(std::memory_order_acquire) != nullptr; }
void submit(Record r) noexcept
{
    // Only Runtime exposes the implementation type; dispatch through a function pointer below.
    extern void push_record(void*, Record) noexcept;
    if (auto* p = runtime.load(std::memory_order_acquire)) push_record(p, std::move(r));
}
void sample(Phase phase, uint64_t us) noexcept
{
    if (!enabled()) return;
    Record r; r.present = uint64_t(1) << size_t(phase); r.us[size_t(phase)] = us;
    submit(std::move(r));
}
TracePtr make_trace(uint32_t height, std::span<const uint8_t,32> hash, uint64_t peer, uint32_t batchSize) noexcept
{
    if (!enabled()) return {};
    if (liveTraces.fetch_add(1) >= 512) { liveTraces.fetch_sub(1); skippedRecords.fetch_add(1); return {}; }
    try {
        Record r; r.id = sequence.fetch_add(1); r.height = height; r.peer = peer; r.batchSize = batchSize;
        std::copy(hash.begin(), hash.end(), r.hash.begin());
        return std::make_shared<Trace>(std::move(r));
    } catch (...) { liveTraces.fetch_sub(1); skippedRecords.fetch_add(1); return {}; }
}
Trace::~Trace()
{
    auto r = identity;
    r.present = present.load(); r.outcome = outcome.load();
    for (size_t i = 0; i < phaseCount; ++i) r.us[i] = us[i].load();
    submit(std::move(r));
    liveTraces.fetch_sub(1);
}
void Trace::accept(TimePoint now) noexcept
{
    if (identity.peer == 0) add(Phase::SubmissionToAccept, microseconds(createdAt, now));
    if (auto received = receivedNs.load(); received)
        add(Phase::ReceiveToAccept, microseconds(TimePoint(std::chrono::nanoseconds(received)), now));
    acceptedNs.store(std::chrono::duration_cast<std::chrono::nanoseconds>(now.time_since_epoch()).count());
    outcome.store(Outcome::Accepted);
}
void Trace::latest_milestone(Phase p, TimePoint now) noexcept
{
    auto accepted = acceptedNs.load();
    if (!accepted) return;
    auto elapsed = microseconds(TimePoint(std::chrono::nanoseconds(accepted)), now);
    auto& value = us[size_t(p)];
    auto old = value.load();
    while (old < elapsed && !value.compare_exchange_weak(old, elapsed)) {}
    present.fetch_or(uint64_t(1) << size_t(p));
}
void Trace::milestone(Phase p, TimePoint now) noexcept
{
    auto accepted = acceptedNs.load();
    if (!accepted) return;
    auto elapsed = microseconds(TimePoint(std::chrono::nanoseconds(accepted)), now);
    // A block is sampled once even when multiple addresses/workers receive a job.
    auto bit = uint64_t(1) << size_t(p);
    auto old = present.fetch_or(bit);
    if (!(old & bit)) us[size_t(p)].store(elapsed);
}
Runtime::Runtime(Mode mode, const std::string& directory)
{
    if (mode != Mode::Off) {
        impl = std::make_unique<Impl>(mode, directory);
        runtime.store(impl.get(), std::memory_order_release);
    }
}
Runtime::~Runtime() { runtime.store(nullptr, std::memory_order_release); }
}
