/**
 * Emission of the PLC data block (`plcDataBlock`): which places name a global
 * through `plc_data`, and that the option changes nothing when it is off.
 * The C++ is compiled and run in tests/integration/plc-data-block-cpp.test.ts.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `
FUNCTION_BLOCK Acc
VAR_EXTERNAL total : DINT; END_VAR
  total := total + 1;
END_FUNCTION_BLOCK

FUNCTION Peek : DINT
VAR_EXTERNAL total : DINT; END_VAR
VAR_INPUT n : DINT; END_VAR
  Peek := total + n;
END_FUNCTION

PROGRAM Main
VAR_EXTERNAL total : DINT; out : BOOL; END_VAR
VAR a : Acc; r : DINT; END_VAR
  a();
  r := Peek(n := 1);
  out := r > 10;
END_PROGRAM

CONFIGURATION Config0
  VAR_GLOBAL total : DINT := 4; out AT %QX0.0 : BOOL; END_VAR
  RESOURCE Res0 ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH t : Main;
  END_RESOURCE
END_CONFIGURATION`;

describe("PLC data block emission", () => {
  const on = compile(SOURCE, {
    headerFileName: "generated.hpp",
    plcDataBlock: true,
  });
  const off = compile(SOURCE, { headerFileName: "generated.hpp" });

  it("compiles both ways", () => {
    expect(on.errors).toEqual([]);
    expect(off.errors).toEqual([]);
  });

  it("puts the globals and the configuration in PlcData", () => {
    expect(on.headerCode).toContain(
      "struct PlcData;\nextern PlcData* plc_data;",
    );
    expect(on.headerCode).toMatch(
      /struct PlcData \{\n {4}uint32_t plc__header = 0;\n {4}GlobalVar<IEC_DINT> TOTAL\{4\};\n {4}GlobalVar<IEC_BOOL> OUT\{false\};\n {4}Configuration_CONFIG0 plc__config;\n\};/,
    );
    expect(on.headerCode).toContain(
      'extern "C" void* strucpp_platform_plc_data_alloc(size_t size);',
    );
    expect(on.cppCode).toContain("PlcData* plc_data = nullptr;");
    expect(on.cppCode).toContain(
      "    plc_data = static_cast<PlcData*>(storage);\n    new (storage) PlcData();",
    );
  });

  it("names globals through plc_data only where code named them directly", () => {
    expect(on.cppCode).toContain("TOTAL(&strucpp::plc_data->TOTAL)");
    expect(on.cppCode).toContain("(&strucpp::plc_data->TOTAL)->");
    expect(on.cppCode).toContain("INSTANCE0(&plc_data->TOTAL, &plc_data->OUT)");
    expect(on.cppCode).toContain(
      "    if (plc_data == nullptr) return nullptr;",
    );
    expect(on.cppCode).toContain(
      "case 0: return plc_data->TOTAL.lock_handle();",
    );
    expect(on.cppCode).toContain("= plc_data->OUT.value.raw_ptr();");
  });

  it("holds offsets, not addresses, in the debug tables", () => {
    expect(on.debugTableCpp).not.toMatch(/\(void\*\)&(?!debug_indirect)/);
    expect(on.debugTableCpp).toContain("STRUCPP_PLC_DATA_BLOCK");
    expect(off.debugTableCpp).not.toContain("STRUCPP_PLC_DATA_BLOCK");
  });

  it("leaves the output unchanged when off", () => {
    const unset = compile(SOURCE, {
      headerFileName: "generated.hpp",
      plcDataBlock: false,
    });
    expect(unset.headerCode).toBe(off.headerCode);
    expect(unset.cppCode).toBe(off.cppCode);
    expect(unset.debugTableCpp).toBe(off.debugTableCpp);
    expect(off.headerCode).not.toContain("PlcData");
    expect(off.cppCode).not.toContain("plc_data");
  });
});
