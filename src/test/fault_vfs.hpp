#pragma once
#include "sqlite3.h"
#include <cstddef>
#include <cstring>

// Test-only forwarding VFS. Faults report I/O errors; they do not simulate a
// physical RAID power cut or a drive falsely acknowledging a flush.
namespace fault_vfs {
inline sqlite3_vfs* original = nullptr;
inline sqlite3_vfs wrapper {};
inline int remaining = -1;
inline bool syncFault = false;
inline bool partialWrite = false;
struct File { sqlite3_file base; sqlite3_file* real; };
inline File* file(sqlite3_file* p) { return reinterpret_cast<File*>(p); }
inline bool fail(bool sync)
{
    if (sync != syncFault || remaining <= 0) return false;
    if (--remaining != 0) return false;
    remaining = -1;
    return true;
}
inline int close(sqlite3_file* p) { return file(p)->real->pMethods->xClose(file(p)->real); }
inline int read(sqlite3_file* p,void* b,int n,sqlite3_int64 o) { return file(p)->real->pMethods->xRead(file(p)->real,b,n,o); }
inline int write(sqlite3_file* p,const void* b,int n,sqlite3_int64 o)
{
    if (fail(false)) {
        if (partialWrite && n > 1) file(p)->real->pMethods->xWrite(file(p)->real,b,n/2,o);
        return SQLITE_IOERR_WRITE;
    }
    return file(p)->real->pMethods->xWrite(file(p)->real,b,n,o);
}
inline int truncate(sqlite3_file* p,sqlite3_int64 n) { return file(p)->real->pMethods->xTruncate(file(p)->real,n); }
inline int sync(sqlite3_file* p,int flags) { return fail(true) ? SQLITE_IOERR_FSYNC : file(p)->real->pMethods->xSync(file(p)->real,flags); }
inline int size(sqlite3_file* p,sqlite3_int64* n) { return file(p)->real->pMethods->xFileSize(file(p)->real,n); }
inline int lock(sqlite3_file* p,int n) { return file(p)->real->pMethods->xLock(file(p)->real,n); }
inline int unlock(sqlite3_file* p,int n) { return file(p)->real->pMethods->xUnlock(file(p)->real,n); }
inline int reserved(sqlite3_file* p,int* n) { return file(p)->real->pMethods->xCheckReservedLock(file(p)->real,n); }
inline int control(sqlite3_file* p,int n,void* a) { return file(p)->real->pMethods->xFileControl(file(p)->real,n,a); }
inline int sector(sqlite3_file* p) { return file(p)->real->pMethods->xSectorSize(file(p)->real); }
inline int device(sqlite3_file* p) { return file(p)->real->pMethods->xDeviceCharacteristics(file(p)->real); }
inline int map(sqlite3_file* p,int n,int size,int extend,void volatile** out) { return file(p)->real->pMethods->xShmMap(file(p)->real,n,size,extend,out); }
inline int shmLock(sqlite3_file* p,int o,int n,int flags) { return file(p)->real->pMethods->xShmLock(file(p)->real,o,n,flags); }
inline void barrier(sqlite3_file* p) { file(p)->real->pMethods->xShmBarrier(file(p)->real); }
inline int unmap(sqlite3_file* p,int del) { return file(p)->real->pMethods->xShmUnmap(file(p)->real,del); }
inline int fetch(sqlite3_file* p,sqlite3_int64 o,int n,void** out) {
    auto m=file(p)->real->pMethods; if (m->iVersion<3 || !m->xFetch) { *out=nullptr; return SQLITE_OK; }
    return m->xFetch(file(p)->real,o,n,out);
}
inline int unfetch(sqlite3_file* p,sqlite3_int64 o,void* out) {
    auto m=file(p)->real->pMethods; return m->iVersion<3 || !m->xUnfetch ? SQLITE_OK : m->xUnfetch(file(p)->real,o,out);
}
inline sqlite3_io_methods methods {3,close,read,write,truncate,sync,size,lock,unlock,reserved,control,sector,device,map,shmLock,barrier,unmap,fetch,unfetch};
inline int open(sqlite3_vfs*,const char* path,sqlite3_file* out,int flags,int* actual)
{
    auto* p = file(out);
    constexpr auto offset = (sizeof(File) + alignof(std::max_align_t)-1) / alignof(std::max_align_t) * alignof(std::max_align_t);
    p->real = reinterpret_cast<sqlite3_file*>(reinterpret_cast<char*>(out) + offset);
    std::memset(p->real,0,original->szOsFile);
    int result = original->xOpen(original,path,p->real,flags,actual);
    p->base.pMethods = result == SQLITE_OK ? &methods : nullptr;
    return result;
}
inline void install()
{
    original = sqlite3_vfs_find(nullptr);
    wrapper = *original;
    wrapper.zName = "warthog-test-faults";
    wrapper.szOsFile = original->szOsFile + sizeof(File) + alignof(std::max_align_t);
    wrapper.xOpen = open;
    sqlite3_vfs_register(&wrapper,0);
}
}
