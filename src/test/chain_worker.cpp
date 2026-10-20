#include "api/types/all.hpp"
#include "api/http/endpoint.hpp"
#include "chainserver/server.hpp"
#include "db/chain_db.hpp"
#include "global/globals.hpp"
#include "nlohmann/json.hpp"
#include <atomic>
#include <chrono>
#include <future>
#include <iostream>
#include <stdexcept>

using namespace std::chrono_literals;
static void check(bool value, const char* message)
{
    if (!value) throw std::runtime_error(message);
}
template <typename T> static void ready(std::future<T>& future)
{
    check(future.wait_for(10s) == std::future_status::ready, "chain worker lost a wakeup or failed to stop");
    future.get();
}
struct Fixture {
    ChainDB db { "", "delete" };
    std::shared_ptr<ChainServer> server;
    Fixture(BatchRegistry& registry) : server(ChainServer::make_chain_server(db, registry, {})) {}
    ~Fixture() { if (server) server->shutdown_join(); }
};

#ifdef WORKER_JOIN_BARRIER
#include <pthread.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
static thread_local std::promise<void>* joining = nullptr;
extern "C" int __real_pthread_join(pthread_t, void**);
extern "C" int __wrap_pthread_join(pthread_t thread, void** result)
{
    // shutdown_join has already published closing before joining its worker.
    if (joining) { joining->set_value(); joining = nullptr; }
    return __real_pthread_join(thread, result);
}
#endif

static void startup()
{
#ifdef WORKER_JOIN_BARRIER
    check(!global().timingLogger.has_value(), "startup test must precede global initialization");
    const int reservation = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in address {}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    check(::bind(reservation, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0, "reserve test endpoint");
    socklen_t length = sizeof(address);
    check(::getsockname(reservation, reinterpret_cast<sockaddr*>(&address), &length) == 0, "read test port");
    ::close(reservation);
    auto connect = [&] {
        int socket = ::socket(AF_INET, SOCK_STREAM, 0);
        if (::connect(socket, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0) return socket;
        ::close(socket); return -1;
    };
    {
        HTTPEndpoint endpoint(EndpointAddress(IPv4(0x7f000001), ntohs(address.sin_port)), false,
            HTTPEndpoint::StartMode::Deferred);
        check(connect() == -1, "deferred endpoint accepted work before initialization");
    } // destroying an endpoint that was never started must also be safe
    HTTPEndpoint endpoint(EndpointAddress(IPv4(0x7f000001), ntohs(address.sin_port)), false,
        HTTPEndpoint::StartMode::Deferred);
    endpoint.start(); endpoint.start();
    int client = -1;
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    while ((client = connect()) == -1 && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(1ms);
    check(client >= 0, "explicit endpoint start did not listen");
    timeval timeout {5, 0};
    ::setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    const std::string request = "GET /tools/version HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    check(::send(client, request.data(), request.size(), 0) == ssize_t(request.size()), "send startup request");
    std::string reply; char buffer[4096]; ssize_t bytes;
    while ((bytes = ::recv(client, buffer, sizeof(buffer), 0)) > 0) {
        reply.append(buffer, bytes);
        auto body = reply.find("\r\n\r\n"), field = reply.find("Content-Length: ");
        if (body != std::string::npos && field != std::string::npos
            && reply.size() >= body + 4 + std::stoul(reply.substr(field + 16))) break;
    }
    ::close(client);
    const auto body = reply.find("\r\n\r\n");
    check(reply.find("200 OK") != std::string::npos && body != std::string::npos,
        "started endpoint did not return HTTP success");
    check(nlohmann::json::parse(reply.substr(body + 4)).at("code") == 0,
        "started endpoint did not serve its request");
#endif
}

static void concurrent(BatchRegistry& registry)
{
    Fixture fixture(registry);
    auto& server = *fixture.server;
    std::atomic<unsigned> errors { 0 };
    // Repeated empty-to-nonempty transitions exercise the idle wait predicate.
    for (unsigned i = 0; i < 200; ++i) {
        std::promise<void> done; auto future = done.get_future();
        server.async_get_head([&](const auto& head) {
            if (!head || head->height != Height(0)) ++errors;
            done.set_value();
        });
        ready(future);
    }
    constexpr unsigned producers = 8, requests = 2000;
    unsigned next[producers] {};
    std::vector<std::thread> threads;
    for (unsigned p = 0; p < producers; ++p) threads.emplace_back([&, p] {
        for (unsigned i = 0; i < requests; ++i) {
            server.async_get_head([&, p, i](const auto& head) {
                if (!head || head->height != Height(0) || next[p]++ != i) ++errors;
            });
            if (i % 17 == 0) std::this_thread::yield();
        }
    });
    for (auto& thread : threads) thread.join();
    std::promise<void> drained; auto future = drained.get_future();
    server.async_get_head([&](const auto&) { drained.set_value(); });
    ready(future);
    check(errors == 0, "concurrent callbacks were reordered, duplicated or invalid");
    for (auto count : next) check(count == requests, "concurrent callback was lost");
    // Callbacks run outside the queue mutex and may enqueue more work.
    std::promise<void> nested; auto nestedFuture = nested.get_future();
    server.async_get_head([&](const auto&) {
        server.async_get_head([&](const auto&) { nested.set_value(); });
    });
    ready(nestedFuture);
}

static void shutdown(BatchRegistry& registry)
{
    for (unsigned i = 0; i < 40; ++i) {
        Fixture fixture(registry);
        fixture.server->shutdown_join(); // idle close and repeated close/join
        fixture.server->shutdown_join();
    }
#ifdef WORKER_JOIN_BARRIER
    for (unsigned round = 0; round < 40; ++round) {
        Fixture fixture(registry);
        std::promise<void> entered, release, joiningWorker;
        auto enteredFuture = entered.get_future();
        auto releaseFuture = release.get_future();
        auto joiningFuture = joiningWorker.get_future();
        std::atomic<unsigned> finished { 0 }, queuedCalls { 0 }, destroyed { 0 };
        auto payload = std::shared_ptr<int>(new int(1), [&](int* p) { delete p; ++destroyed; });
        fixture.server->async_get_head([&](const auto&) {
            entered.set_value(); releaseFuture.wait(); ++finished;
        });
        ready(enteredFuture);
        // These belong to the next batch. Close retains the existing priority:
        // finish the acquired batch, then stop without executing queued work.
        std::vector<std::thread> producers;
        for (unsigned p = 0; p < 4; ++p) producers.emplace_back([&, payload] {
            for (unsigned i = 0; i < 100; ++i)
                fixture.server->async_get_head([&, payload](const auto&) { ++queuedCalls; });
        });
        for (auto& producer : producers) producer.join();
        payload.reset();
        std::thread closer([&] {
            joining = &joiningWorker;
            fixture.server->shutdown_join();
        });
        check(joiningFuture.wait_for(10s) == std::future_status::ready, "shutdown did not reach worker join");
        check(finished == 0 && destroyed == 0, "shutdown released active or queued ownership early");
        release.set_value(); closer.join();
        check(finished == 1 && queuedCalls == 0, "shutdown changed in-flight batch semantics");
        check(destroyed == 0, "queued callback ownership ended before server destruction");
        fixture.server.reset();
        check(destroyed == 1, "queued callback ownership leaked at shutdown");
    }
#endif
}

int main() try
{
    BatchRegistry registry;
    startup();
    global_init(&registry, nullptr, nullptr, nullptr, nullptr, nullptr);
    concurrent(registry);
    shutdown(registry);
    std::cout << "Chain worker: idle wakeups, 16000 ordered callbacks, reentrant enqueue and shutdown passed\n";
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
