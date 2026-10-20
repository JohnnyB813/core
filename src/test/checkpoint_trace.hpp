#pragma once
#include "fault_vfs.hpp"
#include <cstdint>

// Observe SQLite's checkpoint-copy signal without replacing its WAL hook or
// changing the production autocheckpoint policy. Not a full checkpoint timer:
// CKPT_DONE precedes the final database sync in the bundled SQLite version.
namespace checkpoint_trace {
inline uint64_t copies = 0;
inline int control(sqlite3_file* file, int operation, void* argument)
{
    if (operation == SQLITE_FCNTL_CKPT_START) ++copies;
    return fault_vfs::control(file, operation, argument);
}
inline void enable() { fault_vfs::methods.xFileControl = control; }
}
