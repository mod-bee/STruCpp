// SPDX-License-Identifier: GPL-3.0-or-later WITH STruCpp-runtime-exception
// Copyright (C) 2026 Autonomy / OpenPLC Project
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - FB_Init / FB_Exit of a function block (CODESYS "Method:
 * FB_Init, FB_Reinit, FB_Exit").
 *
 * A block with FB_Init or FB_Exit (its own or a base's) gets, beside its
 * public constructor taking the FB_Init inputs:
 *   - `T(FbInitDeferred)`: the implicit initialization only. A derived block
 *     builds its base part with it, so every FB_Init runs once the whole
 *     instance is initialized, base first, from the derived constructor.
 *   - `T(FbInitThen, setter, inputs...)`: the public constructor, then the
 *     declaration's initial assignments (`fb : T(p := 1) := (x := 2)`), in
 *     place: an instance is never copied from a temporary.
 * FB_Exit runs from the destructor of the most derived block, derived first.
 * `FbLife` marks an instance whose FB_Init ran; a copy is not marked, so a
 * copy never runs FB_Exit.
 */

#pragma once

namespace strucpp {

/** Construct the implicit part only; the most derived block runs FB_Init. */
struct FbInitDeferred {};

/** Construct, run FB_Init, then apply the declaration's initial assignments. */
struct FbInitThen {};

/** Construct a global's instance in place from these constructor arguments. */
struct FbCtorArgs {};

/** Set once FB_Init has run; FB_Exit runs only for such an instance. */
class FbLife {
public:
    FbLife() noexcept = default;
    FbLife(const FbLife&) noexcept {}
    FbLife& operator=(const FbLife&) noexcept { return *this; }
    void start() noexcept { live_ = true; }
    /** True once, for the instance FB_Init ran on. */
    bool end() noexcept {
        const bool was = live_;
        live_ = false;
        return was;
    }

private:
    bool live_ = false;
};

}  // namespace strucpp
