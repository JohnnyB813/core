#include "api/http/endpoint.hpp"
#include "block/chain/consensus_headers.hpp"
#include "block/header/header_impl.hpp"
#include "chainserver/state/state.hpp"
#include "communication/messages.hpp"
#include "communication/buffers/sndbuffer.hpp"
#include "block/body/parse.hpp"
#include "crypto/crypto.hpp"
#include "db/chain_db.hpp"
#include "general/hex.hpp"
#include "global/globals.hpp"
#include "eventloop/types/chainstate.hpp"
#include "nlohmann/json.hpp"
#include "sha2.hpp"
#include "sqlite3.h"
#include "fault_vfs.hpp"
#include "checkpoint_trace.hpp"
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>

using json = nlohmann::json;
static void check(bool value, const std::string& message) { if (!value) throw std::runtime_error(message); }
static std::string frame(Sndbuffer buffer)
{
    buffer.writeChecksum();
    return serialize_hex(reinterpret_cast<const uint8_t*>(buffer.ptr.get()), buffer.fullsize());
}
static std::string digest(const std::string& path)
{
    sqlite3* db=nullptr;
    check(sqlite3_open_v2(path.c_str(),&db,SQLITE_OPEN_READONLY,nullptr)==SQLITE_OK,"open digest database");
    SHA256_CTX ctx; sha256_Init(&ctx);
    const char* queries[] {
        "SELECT c.height,CASE WHEN c.height>0 THEN b.hash ELSE c.block_id END,c.history_cursor,c.account_cursor FROM Consensus c LEFT JOIN Blocks b ON b.rowid=c.block_id ORDER BY c.height",
        "SELECT rowid,address,balance FROM State ORDER BY rowid",
        "SELECT id,hash,data FROM History ORDER BY id",
        "SELECT account_id,history_id FROM AccountHistory ORDER BY account_id,history_id",
        "SELECT c.height,b.header,b.body,b.undo FROM Consensus c JOIN Blocks b ON c.block_id=b.rowid WHERE c.height>0 ORDER BY c.height"
    };
    for (const char* query : queries) {
        sha256_Update(&ctx,reinterpret_cast<const uint8_t*>(query),std::strlen(query));
        sqlite3_stmt* stmt=nullptr;
        check(sqlite3_prepare_v2(db,query,-1,&stmt,nullptr)==SQLITE_OK,sqlite3_errmsg(db));
        int rc;
        while ((rc=sqlite3_step(stmt))==SQLITE_ROW) {
            for (int col=0;col<sqlite3_column_count(stmt);++col) {
                uint8_t type=uint8_t(sqlite3_column_type(stmt,col)); sha256_Update(&ctx,&type,1);
                if (type==SQLITE_INTEGER) {
                    uint64_t value=uint64_t(sqlite3_column_int64(stmt,col));
                    std::array<uint8_t,8> bytes{};
                    for (size_t j=0;j<8;++j) bytes[j]=uint8_t(value>>(8*j));
                    sha256_Update(&ctx,bytes.data(),bytes.size());
                } else {
                    auto* bytes=static_cast<const uint8_t*>(sqlite3_column_blob(stmt,col));
                    uint32_t size=uint32_t(sqlite3_column_bytes(stmt,col));
                    std::array<uint8_t,4> length{};
                    for (size_t j=0;j<4;++j) length[j]=uint8_t(size>>(8*j));
                    sha256_Update(&ctx,length.data(),length.size());
                    if (size) sha256_Update(&ctx,bytes,size);
                }
            }
        }
        check(rc==SQLITE_DONE,sqlite3_errmsg(db)); sqlite3_finalize(stmt);
    }
    sqlite3_close(db);
    std::array<uint8_t,32> hash{}; sha256_Final(&ctx,hash.data()); return serialize_hex(hash);
}
int main(int argc,char** argv)
{
    try {
        if (argc==4 && std::string(argv[1])=="--recover") {
            check(sqlite3_libversion_number()>=3051003,"recovery inspection requires candidate SQLite");
            auto directory=std::filesystem::canonical(argv[2]);
            check(std::filesystem::is_regular_file(directory/"PERF_DISPOSABLE"),"refusing unmarked recovery directory");
            SQLite::Database db((directory/"chain.db").string(),SQLite::OPEN_READWRITE);
            check(db.execAndGet("PRAGMA integrity_check").getString()=="ok","recovery integrity check failed");
            auto height=db.execAndGet("SELECT coalesce(max(height),0) FROM Consensus WHERE height>0").getInt64();
            std::ofstream output(argv[3]); output<<json{{"sqlite",sqlite3_libversion()},{"height",height}}.dump()<<'\n';
            return 0;
        }
        check(argc==6,"usage: node_replay DISPOSABLE_DIRECTORY FIXTURE_JSON delete|wal off|summary|detail RESULT_JSON");
        auto directory=std::filesystem::canonical(argv[1]);
        check(std::filesystem::is_regular_file(directory/"PERF_DISPOSABLE"),"refusing database without PERF_DISPOSABLE marker");
        std::string journal=argv[3], diagnostics=argv[4];
        check(journal=="delete" || journal=="wal","invalid journal mode");
        check(diagnostics=="off" || diagnostics=="summary" || diagnostics=="detail","invalid diagnostics mode");
        check(journal!="wal" || sqlite3_libversion_number()>=3051003,"old SQLite comparison tool only supports DELETE");
        std::ifstream input(argv[2]); json fixture; input>>fixture;
        const char* failure=std::getenv("REPLAY_IO_FAILURE");
        const bool checkpointTrace = std::getenv("REPLAY_CHECKPOINT_TRACE") != nullptr;
        if (failure || checkpointTrace) {
            fault_vfs::install();
            if (checkpointTrace) checkpoint_trace::enable();
            sqlite3_vfs_register(&fault_vfs::wrapper,1);
        }
        std::ofstream acknowledgements;
        if (const char* path=std::getenv("REPLAY_ACK")) acknowledgements.open(path);
        ECC_Start();
        struct StopECC { ~StopECC(){ECC_Stop();} } stopECC;
        latency::Runtime runtime(diagnostics=="off" ? latency::Mode::Off : diagnostics=="detail" ? latency::Mode::Detail : latency::Mode::Summary,
            (directory/"latency").string());
        json result { {"sqlite",sqlite3_libversion()},{"journal",journal},{"diagnostics",diagnostics},
            {"apply_us",json::array()},{"stage_set_us",json::array()},{"commit_us",json::array()},{"template_us",json::array()},{"processing_us",json::array()} };
        if (checkpointTrace) result["checkpoint_copies"] = json::array();
        {
            // No external clients or peers; HTTP is only used by the ordinary state
            // publication path. The Docker runner publishes no ports.
            HTTPEndpoint endpoint(EndpointAddress("127.0.0.1:33000"));
            global_init(nullptr,nullptr,nullptr,nullptr,nullptr,&endpoint);
            ChainDB db((directory/"chain.db").string(),journal);
            BatchRegistry registry;
            chainserver::State state(db,registry,{});
            check(state.chainlength().value()==fixture.at("base_height").get<uint32_t>(),"fixture does not extend database backup");
            ExtendableHeaderchain headers { Headerchain(state.get_headers()) };
            auto consensus=state.get_chainstate_concurrent();
            json network { {"base_height",fixture.at("base_height")},{"initial",frame(InitMsg::serialize_chainstate(consensus))},{"steps",json::array()},{"tip_hashes",json::array()} };
            std::optional<Address> payout;
            auto replayStart=latency::Clock::now();
            for (const auto& item : fixture.at("blocks")) {
                auto processingStart=latency::Clock::now();
                if (failure && item.at(0).get<uint32_t>()==fixture.at("base_height").get<uint32_t>()+3) {
                    std::string spec=failure; auto colon=spec.find(':');
                    fault_vfs::remaining=std::stoi(spec.substr(colon+1));
                    fault_vfs::syncFault=spec.substr(0,colon)=="sync";
                    fault_vfs::partialWrite=spec.substr(0,colon)=="partial";
                }
                Block block { NonzeroHeight(item.at(0).get<uint32_t>()), Header(hex_to_arr<80>(item.at(1).get<std::string>())), BodyContainer(hex_to_vec(item.at(2).get<std::string>())), {} };
                check(block.height==state.chainlength()+1,"non-contiguous fixture");
                auto prepared=headers.prepare_append(db.get_signed_snapshot(),block.header);
                check(prepared.has_value(),"recorded header rejected by consensus verification");
                headers.append(*prepared,registry);
                auto began=latency::Clock::now();
                const auto checkpointsBefore = checkpoint_trace::copies;
                auto staged=state.set_stage(Headerchain(headers));
                auto setEnd=latency::Clock::now();
                check(staged.firstMissHeight.has_value(),"stage set rejected");
                block.trace=latency::make_trace(block.height.value(),block.header.hash(),1);
                auto trace=block.trace;
                std::vector<latency::TracePtr> traces{trace};
                latency::Group group(traces);
                latency::Context context(trace);
                std::vector<Block> blocks; blocks.push_back(std::move(block));
                auto [accepted,delta]=state.add_stage(blocks,headers);
                auto applied=latency::Clock::now();
                if (checkpointTrace) result["checkpoint_copies"].push_back(checkpoint_trace::copies - checkpointsBefore);
                check(!accepted.ce && delta.has_value(),"recorded block rejected by state application");
                if (acknowledgements) {
                    acknowledgements<<state.chainlength().value()<<'\n'; acknowledgements.flush();
                    if (const char* pause=std::getenv("REPLAY_PAUSE_US"))
                        std::this_thread::sleep_for(std::chrono::microseconds(std::stoul(pause)));
                }
                if (trace) trace->accept(applied);
                result["stage_set_us"].push_back(latency::microseconds(began,setEnd));
                result["apply_us"].push_back(latency::microseconds(setEnd,applied));
                result["commit_us"].push_back(trace ? json(trace->us[size_t(latency::Phase::Commit)].load()) : json(nullptr));
                if (!payout) {
                    auto account=db.lookup_account(blocks[0].body_view().reward().account_id());
                    check(account.has_value(),"reward account missing"); payout=account->address;
                }
                auto templateStart=latency::Clock::now();
                auto mining=state.mining_task(*payout);
                result["template_us"].push_back(latency::microseconds(templateStart,latency::Clock::now()));
                // Historic fixtures predate the current mining body format.
                check(mining.has_value() || (state.chainlength()+1).value()<NEWBLOCKSTRUCUTREHEIGHT,"mining template unavailable after valid block");
                auto append=consensus.apply(std::move(std::get<chainserver::state_update::Append>(delta->chainstateUpdate))).second;
                network["steps"].push_back(frame(static_cast<Sndbuffer>(append)));
                network["tip_hashes"].push_back(serialize_hex(headers.hash_at(state.chainlength())));
                result["processing_us"].push_back(latency::microseconds(processingStart,latency::Clock::now()));
            }
            result["replay_runtime_us"]=latency::microseconds(replayStart,latency::Clock::now());
            result["height"]=state.chainlength().value();
            result["head_hash"]=serialize_hex(headers.hash_at(state.chainlength()));
            std::ofstream wire(std::string(argv[5])+".wire.json"); wire<<network.dump();
        }
        result["logical_digest"]=digest((directory/"chain.db").string());
        std::ofstream output(argv[5]); output<<result.dump()<<'\n';
        std::cout<<"REPLAY_OK sqlite="<<sqlite3_libversion()<<" height="<<result["height"]<<" digest="<<result["logical_digest"]<<'\n';
        return 0;
    } catch (const std::exception& error) { std::cerr<<"REPLAY_FAILED "<<error.what()<<'\n'; return 1; }
}
