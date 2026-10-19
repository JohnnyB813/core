#include "eventloop/sync/block_download/peer_latency.hpp"
#include "general/latency.hpp"
#include <iostream>
#include <stdexcept>
#include <filesystem>
#include <fstream>
#include "communication/buffers/recvbuffer.hpp"

static void check(bool value, const char* what) { if (!value) throw std::runtime_error(what); }
int main()
{
    using namespace std::chrono;
    using namespace latency;
    using namespace BlockDownload;
    const TimePoint now(seconds(1000));
    check(latency::microseconds(now, now + std::chrono::microseconds(87)) == 87, "microsecond precision");
    check(latency::microseconds(now, now - seconds(1)) == 0, "no negative duration wrap");
    check(!make_trace(1, std::array<uint8_t,32>{}), "off mode must not allocate traces");
    RecordQueue queue;
    for (uint64_t i = 0; i < 1030; ++i) { Record r; r.id = i; queue.push(r); }
    auto records = queue.drain();
    check(records.size() == 1024 && records.front().id == 6 && records.back().id == 1029 && queue.dropped == 6,
        "bounded diagnostics must discard oldest records");
    check(queue.empty(), "drain must release records");
    Rcvbuffer received;
    received.completedAt = now;
    Rcvbuffer moved(std::move(received));
    check(moved.completedAt == now, "network arrival timestamp survives buffer movement");
    auto directory = std::filesystem::temp_directory_path() / ("wart-latency-" + std::to_string(Clock::now().time_since_epoch().count()));
    {
        Runtime runtime(Mode::Detail, directory.string());
        auto trace = make_trace(42, std::array<uint8_t,32>{});
        check(bool(trace), "enabled trace allocation");
        {
            Context context(trace);
            Scope outer(Phase::BlockApply);
            { Scope nested(Phase::Commit); }
            outer.finish();
            check((trace->present.load() & (uint64_t(1) << size_t(Phase::Commit))) != 0, "nested phase retained");
        }
        check(!current, "thread-local context restored");
        trace->receivedNs = duration_cast<nanoseconds>((now - milliseconds(5)).time_since_epoch()).count();
        trace->accept(now);
        check(trace->us[size_t(Phase::ReceiveToAccept)] == 5000, "complete arrival to acceptance span");
        trace->milestone(Phase::MinerWriteQueued, now + milliseconds(10));
        trace->milestone(Phase::MinerWriteQueued, now + milliseconds(20));
        trace->latest_milestone(Phase::MinerLastWriteQueued, now + milliseconds(20));
        trace->latest_milestone(Phase::MinerLastWriteQueued, now + milliseconds(15));
        check(trace->us[size_t(Phase::MinerWriteQueued)] == 10000, "first miner counted once");
        check(trace->us[size_t(Phase::MinerLastWriteQueued)] == 20000, "last miner milestone uses maximum");
        trace->observe_once(Phase::StratumQueue, 5);
        trace->observe_once(Phase::StratumQueue, 100);
        check(trace->us[size_t(Phase::StratumQueue)] == 5, "multiple addresses cannot multiply queue samples");
        trace->outcome = Outcome::Rejected;
        trace.reset();
    }
    std::ifstream log(directory / "latency.log");
    std::string text((std::istreambuf_iterator<char>(log)), {});
    check(text.find("height=42") != std::string::npos && text.find("outcome=rejected") != std::string::npos, "async drain preserves final outcome");
    std::filesystem::remove_all(directory);

    PeerLatency slow, fast, unknown;
    PeerSelector selector;
    std::array peers { PeerCandidate {7,&slow}, PeerCandidate {9,&fast}, PeerCandidate {1,&unknown} };
    check(selector.select(peers, now) == 0, "unknown peers preserve legacy order");
    slow.ping.add(80000, now); fast.ping.add(20000, now);
    check(selector.select(peers, now) == 1, "lower latency wins");
    fast.block.add(200000, now);
    check(selector.select(peers, now) == 0, "real block service time overrides fast ping");
    slow.block.add(80000, now); slow.block.add(160000, now);
    check(slow.block.us == 90000, "EWMA gives new sample one eighth weight");
    check(slow.score(now + seconds(120)) == 90000, "inclusive block freshness");
    check(!slow.score(now + seconds(121)), "stale block and ping excluded");
    slow.ping.add(10000, now + seconds(121));
    check(slow.score(now + seconds(121)) == 10000, "fresh ping fallback");
    slow.block.add(1234, now + seconds(121));
    check(slow.block.us == 1234, "expired EWMA starts with the new measurement");
    check(!slow.score(now - seconds(1)), "future samples ignored");
    PeerSelector exploration;
    slow = PeerLatency {}; fast = PeerLatency {}; unknown = PeerLatency {};
    slow.block.add(80000, now); fast.block.add(20000, now);
    slow.lastSelected = fast.lastSelected = unknown.lastSelected = 0;
    for (int i = 1; i < 32; ++i) check(exploration.select(peers, now) == 1, "measured fast peer preferred");
    check(exploration.select(peers, now) == 2, "32nd selection explores least-used peer with stable ID tie break");
    PeerLatency reconnected;
    check(!reconnected.score(now), "reconnected peer starts without prior scores");
    reconnected.observe_block(false, false, 1, now, now + milliseconds(1));
    reconnected.observe_block(true, true, 1, now, now + milliseconds(1));
    reconnected.observe_block(true, false, 30, now, now + milliseconds(1));
    check(!reconnected.block.us, "stale, expired and bulk responses cannot improve single-block scores");
    reconnected.observe_block(true, false, 1, now, now + milliseconds(2));
    check(reconnected.block.us == 2000, "validated nonexpired single-block response recorded");
    std::array qualified { PeerCandidate {9,&fast} };
    check(selector.select(qualified, now) == 0, "selector cannot introduce an ineligible or busy peer");
    std::cout << "latency policy contracts passed\n";
}
