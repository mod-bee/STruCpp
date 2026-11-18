#include "generated.hpp"
#include "debug_dispatch.hpp"
#include "iec_retain.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
strucpp::Configuration_CONFIG0 g_config;
using namespace strucpp;

static uint8_t wr(uint8_t a, uint16_t e, const uint8_t* b, uint16_t n) { return debug::handle_write(a, e, b, n); }
static uint16_t sz(uint8_t a, uint16_t e) { return debug::handle_size(a, e); }
static uint16_t rd(uint8_t a, uint16_t e, uint8_t* d) { return debug::handle_read(a, e, d); }
static const retain::Host kHost = {
  &debug::handle_retain_leaf, rd, wr, &debug::handle_read_text, &debug::handle_write_text, sz,
};

static std::vector<uint8_t> unhex(const char* s) {
  std::vector<uint8_t> out;
  for (size_t i = 0; s[i] && s[i + 1]; i += 2) {
    char b[3] = {s[i], s[i + 1], 0};
    out.push_back((uint8_t)strtoul(b, nullptr, 16));
  }
  return out;
}

int main(int argc, char** argv) {
  static uint8_t blob[65535];
  for (int i = 1; i < argc; ++i) {
    const char* cmd = argv[i];
    if (!strcmp(cmd, "set")) {
      FILE* f = fopen(argv[++i], "r");
      unsigned a, e; char kind[8]; static char hex[140000];
      while (fscanf(f, "%u %u %7s %139999s", &a, &e, kind, hex) == 4) {
        std::vector<uint8_t> v = unhex(strcmp(hex, "-") ? hex : "");
        uint8_t st = kind[0] == 't'
          ? debug::handle_write_text((uint8_t)a, (uint16_t)e, v.data(), (uint16_t)v.size())
          : debug::handle_write((uint8_t)a, (uint16_t)e, v.data(), (uint16_t)v.size());
        if (st != 0x7E) { printf("SETFAIL %u %u %02x\n", a, e, st); return 2; }
      }
      fclose(f);
    } else if (!strcmp(cmd, "save2") || !strcmp(cmd, "save1")) {
      size_t n = !strcmp(cmd, "save2") ? retain::pack2(blob, sizeof blob, kHost)
                                       : retain::pack(blob, sizeof blob, rd, sz);
      FILE* f = fopen(argv[++i], "wb"); fwrite(blob, 1, n, f); fclose(f);
      printf("SAVED %s %zu\n", cmd, n);
    }
  }
  return 0;
}
