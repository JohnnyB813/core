#pragma once
#include "types/peer_requests.hpp"
#include <cassert>
#include <chrono>
#include <compare>
#include <limits>
#include <map>
#include <optional>
#include <stdexcept>
#include <utility>
#include <variant>
#include <vector>

class Timer {

public:
    struct WithConnecitonId {
        uint64_t conId;
    };
    struct SendPing: public WithConnecitonId {
    };
    struct Expire: public WithConnecitonId {
    };
    struct Req {
        Request req;
    };
    struct CloseNoReply: public WithConnecitonId {
    };
    struct CloseNoPong: public WithConnecitonId {
    };
    struct Connect {
    };
    using Event = std::variant<SendPing, Expire, CloseNoReply,CloseNoPong, Connect>;

private:
    using time_point = std::chrono::steady_clock::time_point;

public:
    struct Key {
        time_point deadline;
        uint64_t generation;
        auto operator<=>(const Key&) const = default;
    };
    // A value remains safe to cancel after expiry or an earlier cancellation.
    using Handle = std::optional<Key>;

private:
    using Ordered = std::map<Key, Event>;

public:
    // Methods

    template <typename _Rep, typename _Period>
    auto insert(std::chrono::duration<_Rep,_Period> duration, Event e){
        auto expires = std::chrono::steady_clock::now() + duration;
        return insert(expires,e);
    }
    auto insert(std::chrono::steady_clock::time_point expires, Event e){
        if (nextGeneration == std::numeric_limits<uint64_t>::max())
            throw std::overflow_error("Timer handle generation exhausted");
        Key key { expires, nextGeneration++ };
        const bool inserted = ordered.emplace(key, std::move(e)).second;
        assert(inserted);
        return Handle { key };
    }
    void cancel(Handle handle)
    {
        if (handle)
            ordered.erase(*handle);
    }
    Handle end() const { return {}; }
    std::vector<Event> pop_expired();
    time_point next();

private:
    Ordered ordered;
    uint64_t nextGeneration { 0 };
};

