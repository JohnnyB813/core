#pragma once

#include "block/body/view.hpp"
#include "block/header/header.hpp"
#include "block/chain/height.hpp"
#include "block/body/container.hpp"
#include <vector>
#include "general/latency.hpp"

struct Block {
    NonzeroHeight height;
    Header header;
    BodyContainer body;
    latency::TracePtr trace {};
    BodyView body_view() const {return body.view(height);}
    bool operator==(const Block& other) const { return height == other.height && header == other.header && body == other.body; }
    operator bool() { return body.size() > 0; }
};
