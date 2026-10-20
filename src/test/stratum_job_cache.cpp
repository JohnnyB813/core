#include "api/stratum/job_cache.hpp"
#include <iostream>
#include <stdexcept>

namespace {
void check(bool condition, const char* message)
{
    if (!condition)
        throw std::runtime_error(message);
}

// Cache fixtures only: these are deliberately not valid mined blocks.
Block block(uint8_t previousHash, uint8_t marker)
{
    Header header;
    header.fill(0);
    header[0] = previousHash;
    std::vector<uint8_t> body(28, 0);
    body[0] = marker;
    return { NonzeroHeight { NEWBLOCKSTRUCUTREHEIGHT }, header,
        BodyContainer { std::move(body) } };
}
}

int main()
{
    stratum::JobCache jobs;
    check(jobs.latest() == nullptr, "Empty cache has a latest job");
    check(jobs.find("missing") == nullptr, "Unknown job was found");

    check(jobs.add("ff", block(1, 10)) != nullptr, "First job was rejected");
    check(jobs.add("00", block(1, 20)) != nullptr, "Second job was rejected");
    check(jobs.latest()->first == "00", "Latest job follows hash sort order");
    check(jobs.find("ff") != nullptr, "Same-tip job was discarded");
    check(jobs.add("ff", block(1, 99)) == nullptr, "Duplicate job was accepted");
    check(jobs.latest()->first == "00", "Duplicate feed reverted the latest job");
    check(jobs.find("ff")->block().body.data()[0] == 10, "Duplicate feed replaced a job");

    check(jobs.add("80", block(1, 30)) != nullptr, "Third job was rejected");
    check(jobs.latest()->first == "80", "Arrival order was not retained");
    check(jobs.add("40", block(2, 40)) != nullptr, "New-tip job was rejected");
    check(jobs.latest()->first == "40", "New tip retained the old latest job");
    check(jobs.find("ff") == nullptr && jobs.find("00") == nullptr
            && jobs.find("80") == nullptr,
        "Stale jobs survived a tip change");

    jobs.clear();
    check(jobs.latest() == nullptr && jobs.find("40") == nullptr,
        "Clearing jobs retained a template");
    check(jobs.add("40", block(3, 50)) != nullptr, "Cleared job ID cannot be reused");
    check(jobs.latest()->second.block().body.data()[0] == 50, "Reused ID returned stale data");
    std::cout << "Stratum job cache: arrival order, duplicate feeds, tip changes, and clear passed\n";
}
