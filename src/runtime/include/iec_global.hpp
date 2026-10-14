// ============================================================================
// WARNING: KEEP THIS HEADER C++14-CLEAN (see iec_var.hpp for the full rationale).
// ----------------------------------------------------------------------------
// This header is included by strucpp's emitted code, which on some Arduino cores
// (mbed-based: Nano RP2040/33 BLE, Opta, GIGA, Portenta, Edge) is compiled under
// `-std=gnu++14`. Do NOT use C++17/20 features unguarded (no `if constexpr`, no
// `std::trait_v`, no inline variables, no <optional>/<variant>/<string_view>).
// `auto` return-type deduction and generic/`decltype` trailing returns are C++14
// and OK. The <mutex> include + all locks are `#ifdef STRUCPP_THREADED`, so the
// baremetal (Arduino) build never pulls them in; a threaded firmware without
// <mutex> takes its locks from the platform (STRUCPP_PLATFORM_THREADS). Codegen
// emits with_lock() lambdas with CONCRETE parameter types (not `auto*`) to stay
// portable.
// ============================================================================

/**
 * @file iec_global.hpp
 * @brief Shared-global wrapper (value + per-global mutex) for VAR_GLOBAL /
 *        VAR_EXTERNAL.
 *
 * A CONFIGURATION `VAR_GLOBAL` is emitted as a `GlobalVar<V>` MEMBER of the
 * configuration — one object bundling the canonical storage (`value`, the real
 * IEC type, e.g. `IEC_BOOL` or a function-block type) with that global's own
 * mutex. A PROGRAM's `VAR_EXTERNAL` reference is emitted as a plain
 * `GlobalVar<V>*` pointing at that single canonical object. There is exactly one
 * mutex per global (it lives on the canonical); locking "through the external
 * pointer" locks the shared canonical.
 *
 *   - NON-THREADED (baremetal / single task): the mutex and locks compile out;
 *     accesses go straight to `value`. Zero overhead.
 *
 *   - STRUCPP_THREADED (openplc-runtime v4): every access (read / write / field
 *     / FB call) is serialized on the global's own mutex — fine-grained, so a
 *     lock is held for one access and never nested with another global's lock,
 *     except a global FB instance's lock, held across that instance's own call.
 *     The mutex is recursive. Contract: per-access validity (no torn read/write);
 *     conflicts resolve last-writer-in-time. Data-agnostic — scalars, structs,
 *     arrays, and FB instances all work, and different-field writes from
 *     different tasks all survive because they mutate the one shared object.
 *
 * read() returns the real IEC value type — `V` itself, i.e. `IECVar<T>`, NOT the
 * underlying `T`. That matters for deduction: the constrained std-lib templates
 * take one shared parameter for both operands (`template<typename T> T ADD(T, T)`),
 * and locals, literals and composite-global fields all present as `IECVar<T>`.
 * Returning `T` here would make a scalar global the one operand kind that differs,
 * and `ADD(aGlobal, aLocal)` would fail to deduce — implicit conversions are not
 * considered during template argument deduction, so `operator T()` cannot rescue it.
 * Forcing is preserved: the copy handed back is built through the canonical's
 * get(), so it carries the effective forced value (with the force flag cleared, as
 * a detached snapshot should); located globals additionally honor the image
 * forced-slot bitmap.
 */
#ifndef STRUCPP_IEC_GLOBAL_HPP
#define STRUCPP_IEC_GLOBAL_HPP

#include "iec_var.hpp"

#ifdef STRUCPP_THREADED
#ifdef STRUCPP_PLATFORM_THREADS
// The platform supplies the locks where the toolchain has no <mutex> (the ARM
// Arduino cores). One lock per global, created with it; the holding thread must
// be able to take it again. try_lock returns true when it took the lock.
extern "C" void *strucpp_platform_mutex_create(void);
extern "C" void strucpp_platform_mutex_lock(void *mutex);
extern "C" void strucpp_platform_mutex_unlock(void *mutex);
extern "C" bool strucpp_platform_mutex_try_lock(void *mutex);
#else
#include <mutex>
#endif
#endif

namespace strucpp {
namespace detail {
#if defined(STRUCPP_THREADED) && defined(STRUCPP_PLATFORM_THREADS)
/** A global's lock, from the platform. */
class GlobalMutex {
   public:
    GlobalMutex() : handle_(strucpp_platform_mutex_create()) {}
    GlobalMutex(const GlobalMutex&) = delete;
    GlobalMutex& operator=(const GlobalMutex&) = delete;
    void lock() const { strucpp_platform_mutex_lock(handle_); }
    void unlock() const { strucpp_platform_mutex_unlock(handle_); }
    bool try_lock() const { return strucpp_platform_mutex_try_lock(handle_); }

   private:
    void *handle_;
};

/** Held for one access, as std::lock_guard would be. */
class GlobalLock {
   public:
    explicit GlobalLock(const GlobalMutex& mutex) : mutex_(mutex) { mutex_.lock(); }
    ~GlobalLock() { mutex_.unlock(); }
    GlobalLock(const GlobalLock&) = delete;
    GlobalLock& operator=(const GlobalLock&) = delete;

   private:
    const GlobalMutex& mutex_;
};
#elif defined(STRUCPP_THREADED)
// Recursive: the thread holding a global FB instance's lock around its call
// may reach that same global again from the instance's body.
using GlobalMutex = std::recursive_mutex;
using GlobalLock  = std::lock_guard<std::recursive_mutex>;
#endif

#ifdef STRUCPP_THREADED
/** A global's lock taken by index, for the generated strucpp_global_* hooks;
 *  null for an index that names no global. */
inline bool global_try_lock(GlobalMutex* m) { return m != nullptr && m->try_lock(); }
inline void global_lock(GlobalMutex* m) {
    if (m != nullptr) m->lock();
}
inline void global_unlock(GlobalMutex* m) {
    if (m != nullptr) m->unlock();
}
#endif
}  // namespace detail
}  // namespace strucpp

namespace strucpp {

template <typename V>
class GlobalVar {
   public:
    /** Canonical storage — the real IEC value/instance. Public so the located
     *  binding and debug exports can reach it (e.g. `g.value.raw_ptr()`), and so
     *  with_lock() can hand out a pointer to it. */
    V value;

    GlobalVar() = default;
    /** Forward an initial value to the underlying IEC type. */
    template <typename T>
    explicit GlobalVar(T init) : value(init) {}

    // Non-copyable / non-movable: the mutex is; and a canonical global is a
    // fixed configuration member that nothing copies.
    GlobalVar(const GlobalVar&) = delete;
    GlobalVar& operator=(const GlobalVar&) = delete;

    /** Scalar read: returns the real IEC value type (forcing-aware),
     *  deduction-friendly. Only instantiated for scalar globals (codegen uses
     *  with_lock() for structs / arrays / FB instances).
     *
     *  The return type is spelled `V` rather than `auto` on purpose: `auto` let
     *  this silently return the underlying scalar, which is what broke deduction
     *  for every mixed global/local operand pair (see the header note above).
     *
     *  The copy is constructed while `lg` is still in scope, so the snapshot is
     *  taken atomically exactly as a `value.get()` would have been — same single
     *  lock acquisition, same hold duration. */
    V read() const {
#ifdef STRUCPP_THREADED
        detail::GlobalLock lg(mtx_);
#endif
        return value;
    }

    /** Scalar write (forcing-aware via set()). */
    template <typename T>
    void write(T v) {
#ifdef STRUCPP_THREADED
        detail::GlobalLock lg(mtx_);
#endif
        value.set(v);
    }

    /** Locked direct access to the canonical, for field / array-element
     *  reads-writes and function-block calls: `f` receives `V*` (a pointer to
     *  `value`) and runs under the global's lock. Returns whatever `f` returns
     *  (a field's real type on reads → deduction-friendly). */
    template <typename F>
    auto with_lock(F&& f) -> decltype(f(static_cast<V*>(nullptr))) {
#ifdef STRUCPP_THREADED
        detail::GlobalLock lg(mtx_);
#endif
        return f(&value);
    }

#ifdef STRUCPP_THREADED
    /** This global's lock, for a runtime that locks globals by index. */
    detail::GlobalMutex* lock_handle() const { return &mtx_; }

   private:
    mutable detail::GlobalMutex mtx_;
#endif
};

/**
 * The call lock, for a block or function call that works on shared globals in
 * place (VAR_IN_OUT, a global instance) and may itself take a global's lock
 * (VAR_EXTERNAL, an interface). Such a call takes this lock first, then holds
 * each global it works on (GlobalHold) until it returns, so the call reads and
 * writes the globals' own storage and no other task's write to them is undone
 * (IEC 61131-3 Ed.3 6.8.2 g; Table 13: an in-out is the caller's variable).
 * Every other access holds one global's lock for one step and waits for no
 * lock while holding it, so only the holder of the call lock ever waits for a
 * lock while holding one: no two tasks can wait for each other.
 */
#ifdef STRUCPP_THREADED
namespace detail {
inline GlobalMutex& call_mutex() {
    static GlobalMutex m;
    return m;
}
}  // namespace detail

class GlobalCallLock {
   public:
    GlobalCallLock() { detail::call_mutex().lock(); }
    ~GlobalCallLock() { detail::call_mutex().unlock(); }
    GlobalCallLock(const GlobalCallLock&) = delete;
    GlobalCallLock& operator=(const GlobalCallLock&) = delete;
};

/** A global's own lock held for a scope (under the call lock). */
class GlobalHold {
   public:
    template <typename V>
    explicit GlobalHold(GlobalVar<V>* g) : m_(g->lock_handle()) { m_->lock(); }
    ~GlobalHold() { m_->unlock(); }
    GlobalHold(const GlobalHold&) = delete;
    GlobalHold& operator=(const GlobalHold&) = delete;

   private:
    detail::GlobalMutex* m_;
};
#else
class GlobalCallLock {};

class GlobalHold {
   public:
    template <typename V>
    explicit GlobalHold(GlobalVar<V>*) {}
};
#endif

}  // namespace strucpp

#endif  // STRUCPP_IEC_GLOBAL_HPP
