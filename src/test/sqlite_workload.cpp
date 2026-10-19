#include "sqlite3.h"
#include "fault_vfs.hpp"
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using Clock = std::chrono::steady_clock;
static void check(bool ok,const std::string& what) { if (!ok) throw std::runtime_error(what); }
static void sql(sqlite3* db,const std::string& query)
{ check(sqlite3_exec(db,query.c_str(),nullptr,nullptr,nullptr)==SQLITE_OK,sqlite3_errmsg(db)); }
static int64_t number(sqlite3* db,const std::string& query)
{
    sqlite3_stmt* s=nullptr;
    check(sqlite3_prepare_v2(db,query.c_str(),-1,&s,nullptr)==SQLITE_OK,sqlite3_errmsg(db));
    check(sqlite3_step(s)==SQLITE_ROW,sqlite3_errmsg(db));
    auto result=sqlite3_column_int64(s,0); sqlite3_finalize(s); return result;
}
static void integrity(sqlite3* db)
{
    sqlite3_stmt* s=nullptr;
    check(sqlite3_prepare_v2(db,"PRAGMA integrity_check",-1,&s,nullptr)==SQLITE_OK,"prepare integrity");
    check(sqlite3_step(s)==SQLITE_ROW && std::string(reinterpret_cast<const char*>(sqlite3_column_text(s,0)))=="ok","integrity_check failed");
    sqlite3_finalize(s);
}
static sqlite3* open(const std::string& path,const std::string& mode,const char* vfs=nullptr)
{
    check(mode!="wal" || sqlite3_libversion_number()>=3051003,"old SQLite comparison tool supports DELETE only");
    sqlite3* db=nullptr;
    check(sqlite3_open_v2(path.c_str(),&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE,vfs)==SQLITE_OK,"open failed");
    sql(db,"PRAGMA journal_mode="+mode); sql(db,"PRAGMA synchronous=FULL");
    sql(db,"PRAGMA wal_autocheckpoint=1000");
    check(number(db,"PRAGMA synchronous")==2,"FULL durability required");
    sql(db,"CREATE TABLE IF NOT EXISTS PerfTransactions(id INTEGER PRIMARY KEY, payload BLOB NOT NULL)");
    return db;
}
static void transaction(sqlite3* db,int i)
{
    sql(db,"BEGIN");
    // Enough page traffic to cross the default checkpoint threshold repeatedly.
    sql(db,"INSERT INTO PerfTransactions VALUES("+std::to_string(i)+",CAST(replace(hex(zeroblob(4096)),'0',char(65+"+std::to_string(i)+"%26)) AS BLOB))");
}
static void recovery_tests(const std::filesystem::path& directory)
{
    fault_vfs::install();
    unsigned cases=0, injected=0, checkpointFaults=0;
    for (const auto& mode : {"delete","wal"}) {
      for (int checkpoint : {1000,1}) {
        if (checkpoint==1 && std::string(mode)!="wal") continue;
        for (int kind : {0,1,2}) for (int fault=1;fault<=40;++fault) {
            auto path=directory / (std::string(mode)+"-"+std::to_string(cases++)+".db");
            auto* db=open(path.string(),mode,"warthog-test-faults");
            // Force checkpoints in one WAL group so write/flush failures also
            // cover checkpoint/reset work. Production and benchmarks keep 1000.
            sql(db,"PRAGMA wal_autocheckpoint="+std::to_string(checkpoint));
            transaction(db,1); sql(db,"COMMIT");
            fault_vfs::remaining=fault; fault_vfs::syncFault=kind==2; fault_vfs::partialWrite=kind==1;
            int acknowledged=1;
            try {
                for (int i=2;i<=8;++i) { transaction(db,i); sql(db,"COMMIT"); acknowledged=i; }
            } catch (const std::exception&) {}
            const bool fired=fault_vfs::remaining==-1;
            injected+=fired;
            if (checkpoint==1) checkpointFaults+=fired;
            fault_vfs::remaining=-1;
            sqlite3_close(db);
            db=open(path.string(),mode);
            integrity(db);
            check(number(db,"SELECT count(*) FROM PerfTransactions WHERE id<="+std::to_string(acknowledged))==acknowledged,"acknowledged transaction lost");
            check(number(db,"SELECT count(*) FROM PerfTransactions WHERE payload!=CAST(replace(hex(zeroblob(4096)),'0',char(65+id%26)) AS BLOB)")==0,"partial transaction survived");
            sqlite3_close(db);
        }
      }
    }
    check(checkpointFaults>0,"checkpoint fault group did not inject errors");
    sqlite3_vfs_unregister(&fault_vfs::wrapper);
    std::cout << "write/sync recovery cases=" << cases << " injected_errors=" << injected
              << " checkpoint_group_errors=" << checkpointFaults << " controls=" << cases-injected << '\n';
}
int main(int argc,char** argv)
{
    try {
        if (argc==4 && std::string(argv[1])=="--verify") {
            std::filesystem::path dir=std::filesystem::canonical(argv[2]);
            check(std::filesystem::is_regular_file(dir/"PERF_DISPOSABLE"),"refusing unmarked recovery directory");
            sqlite3* db=nullptr;
            check(sqlite3_open_v2((dir/"chain.db").string().c_str(),&db,SQLITE_OPEN_READWRITE,nullptr)==SQLITE_OK,"open recovery database");
            integrity(db);
            auto acknowledged=std::stoll(argv[3]);
            check(number(db,"SELECT count(*) FROM PerfTransactions WHERE id<="+std::to_string(acknowledged))==acknowledged,"acknowledged commit lost after SIGKILL");
            check(number(db,"SELECT count(*) FROM PerfTransactions WHERE payload!=CAST(replace(hex(zeroblob(4096)),'0',char(65+id%26)) AS BLOB)")==0,"partial payload after SIGKILL");
            sqlite3_close(db); return 0;
        }
        if (argc==1) {
            auto dir=std::filesystem::temp_directory_path() / ("warthog-sqlite-recovery-"+std::to_string(Clock::now().time_since_epoch().count()));
            check(std::filesystem::create_directory(dir),"unique recovery directory");
            try { recovery_tests(dir); } catch (...) { std::filesystem::remove_all(dir); throw; }
            std::filesystem::remove_all(dir); return 0;
        }
        check(argc==5 || argc==6,"usage: sqlite_workload DIRECTORY MODE COUNT RESULT_JSON [ACK_FILE]");
        std::filesystem::path dir=std::filesystem::canonical(argv[1]);
        check(std::filesystem::is_regular_file(dir/"PERF_DISPOSABLE"),"refusing unmarked database: requires PERF_DISPOSABLE");
        std::string mode=argv[2]; check(mode=="wal" || mode=="delete","invalid mode");
        auto* db=open((dir/"chain.db").string(),mode);
        sql(db,"DELETE FROM PerfTransactions");
        std::vector<int64_t> commits,totals;
        std::ofstream ack;
        if (argc==6) ack.open(argv[5],std::ios::app);
        int count=std::stoi(argv[3]);
        for (int i=1;i<=count;++i) {
            auto start=Clock::now(); transaction(db,i); auto before=Clock::now(); sql(db,"COMMIT"); auto after=Clock::now();
            commits.push_back(std::chrono::duration_cast<std::chrono::microseconds>(after-before).count());
            totals.push_back(std::chrono::duration_cast<std::chrono::microseconds>(after-start).count());
            if (ack) { ack << i << '\n'; ack.flush(); }
        }
        check(number(db,"SELECT count(*) FROM PerfTransactions")==count,"workload count mismatch");
        integrity(db);
        std::ofstream result(argv[4]);
        result << "{\"sqlite\":\"" << sqlite3_libversion() << "\",\"mode\":\"" << mode << "\",\"commit_us\":[";
        for (size_t i=0;i<commits.size();++i) result << (i?",":"") << commits[i];
        result << "],\"transaction_us\":[";
        for (size_t i=0;i<totals.size();++i) result << (i?",":"") << totals[i];
        result << "]}\n";
        sqlite3_close(db);
        return 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
