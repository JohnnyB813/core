#include "eventloop/timer.hpp"
#include <iostream>
#include <stdexcept>

static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}

int main() try
{
    Timer timers;
    const auto past = std::chrono::steady_clock::now() - std::chrono::seconds(1);
    const auto future = std::chrono::steady_clock::now() + std::chrono::hours(1);
    const auto ping = timers.insert(past, Timer::CloseNoPong { 1 });
    const auto request = timers.insert(past, Timer::CloseNoReply { 1 });
    const auto connection = timers.insert(future, Timer::Connect {});
    check(timers.next() == past, "next deadline did not select the earliest event");
    const auto first = timers.pop_expired();
    check(first.size() == 2 && std::holds_alternative<Timer::CloseNoPong>(first[0])
            && std::holds_alternative<Timer::CloseNoReply>(first[1]),
        "same-deadline events lost insertion order");
    check(timers.next() == future, "future timer expired early");

    timers.cancel(ping);
    timers.cancel(request);
    timers.cancel(request);
    check(timers.pop_expired().empty(), "cancelling expired handles changed pending events");
    timers.cancel(connection);
    timers.cancel(connection);
    timers.cancel(timers.end());

    for (unsigned i = 0; i < 10000; ++i) {
        const auto handle = timers.insert(past, Timer::Expire { i });
        if (i % 2 == 0) timers.cancel(handle);
    }
    const auto expired = timers.pop_expired();
    check(expired.size() == 5000, "cancelled timers were delivered");
    for (unsigned i = 0; i < expired.size(); ++i)
        check(std::get<Timer::Expire>(expired[i]).conId == 2 * i + 1, "timer ordering changed");

    const auto replacement = timers.insert(past, Timer::CloseNoReply { 2 });
    timers.cancel(request);
    const auto last = timers.pop_expired();
    check(last.size() == 1 && std::get<Timer::CloseNoReply>(last[0]).conId == 2,
        "an obsolete handle cancelled its replacement");
    timers.cancel(replacement);
    check(timers.pop_expired().empty(), "expired replacement remained pending");
    std::cout << "Timer handles: expiry, repeated cancellation, obsolete handles and 10000 events passed\n";
} catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
}
