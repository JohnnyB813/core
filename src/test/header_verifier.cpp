#include "block/chain/consensus_headers.hpp"
#include "block/header/header_impl.hpp"
#include "eventloop/chain_cache.hpp"
#include "general/now.hpp"
#include <cstring>
#include <iostream>
#include <set>
#include <stdexcept>

static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}

struct SyntheticChain : Headerchain {
    void add(const Header& header, BatchRegistry& registry)
    {
        incompleteBatch.append(header);
        if (incompleteBatch.complete()) {
            finalPin = registry.share(std::move(incompleteBatch), finalPin);
            completeBatches.push_back(finalPin);
            incompleteBatch.clear();
        }
    }
    void finish() { initialize_worksum(); }
};

static void compare(const HeaderVerifier& rebuilt, const HeaderVerifier& sequential)
{
    check(rebuilt.height() == sequential.height(), "rebuilt prefix height differs");
    check(rebuilt.final_hash() == sequential.final_hash(), "rebuilt prefix hash differs");
    check(rebuilt.next_target() == sequential.next_target(), "rebuilt prefix target differs");
    // Future synthetic timestamps make the median observable through the public API.
    // Height zero uses the wall clock, which could tick between these calls.
    if (rebuilt.height() != 0)
        check(rebuilt.get_valid_timestamp() == sequential.get_valid_timestamp(), "rebuilt timestamp window differs");
}

int main() try
{
    BatchRegistry registry;
    SyntheticChain chain;
    HeaderVerifier builder;
    constexpr unsigned tip = 2 * HEADERBATCHSIZE + MEDIAN_N + 7;
    const uint32_t start = now_timestamp() + 1000000;
    for (unsigned h = 1; h <= tip; ++h) {
        Header header {};
        header.fill(0);
        const auto previous = builder.final_hash();
        std::memcpy(header.data() + HeaderView::offset_prevhash, previous.data(), previous.size());
        const uint32_t timestamp = hton32(start + h * 20 + h % 7);
        const uint32_t target = builder.next_target().binary();
        const uint32_t version = hton32(1);
        std::memcpy(header.data() + HeaderView::offset_timestamp, &timestamp, sizeof(timestamp));
        std::memcpy(header.data() + HeaderView::offset_target, &target, sizeof(target));
        std::memcpy(header.data() + HeaderView::offset_version, &version, sizeof(version));
        // This is an initialization oracle, not a PoW fixture. Append the same
        // synthetic headers to the sequential verifier and the stored chain.
        builder.append(NonzeroHeight(h), { header, header.hash() });
        chain.add(header, registry);
    }
    chain.finish();

    std::set<unsigned> prefixes { tip };
    for (unsigned h = 0; h <= MEDIAN_N + 3; ++h) prefixes.insert(h);
    for (unsigned h = 720; h < tip; h += 720)
        for (int offset : { -1, 0, 1 }) prefixes.insert(h + offset);
    for (unsigned h : { HEADERBATCHSIZE, 2 * HEADERBATCHSIZE })
        for (int offset : { -2, -1, 0, 1, 2 }) prefixes.insert(h + offset);

    ConsensusSlave slave({}, Descriptor(0), Headerchain(chain));
    StageAndConsensus cache(slave);
    HeaderVerifier sequential;
    unsigned cases = 0;
    for (unsigned h = 0; h <= tip; ++h) {
        if (h) {
            const HeaderView header = chain[NonzeroHeight(h)];
            sequential.append(NonzeroHeight(h), { header, chain.hash_at(Height(h)) });
        }
        if (!prefixes.contains(h)) continue;
        HeaderVerifier rebuilt(chain, Height(h));
        compare(rebuilt, sequential);
        ++cases;
        if (h) {
            const Batchslot slot { NonzeroHeight(h) };
            const auto batch = chain.get_headers(slot.lower(), NonzeroHeight(h + 1));
            const auto selected = cache.header_verifier(HeaderRange(slot, batch));
            check(selected.has_value(), "chain cache could not reconstruct a matching prefix");
            compare(*selected, sequential);
            if (h % HEADERBATCHSIZE == 0) {
                const SharedBatch pin(chain.complete_batches()[h / HEADERBATCHSIZE - 1]);
                compare(HeaderVerifier(pin), sequential);
            }
        }
        auto continued = sequential;
        for (unsigned next = h + 1; next <= tip && next <= h + MEDIAN_N + 3; ++next) {
            const HeaderView header = chain[NonzeroHeight(next)];
            const HeaderVerifier::PreparedAppend append { header, chain.hash_at(Height(next)) };
            rebuilt.append(NonzeroHeight(next), append);
            continued.append(NonzeroHeight(next), append);
            compare(rebuilt, continued);
        }
    }
    const Headerchain empty;
    compare(HeaderVerifier(empty, Height(0)), HeaderVerifier());
    std::cout << "Header verifier: " << cases << " prefixes, cached prefixes and continued windows passed\n";
} catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
}
