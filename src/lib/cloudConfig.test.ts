/**
 * 云端配置判断的测试（纯函数，不连网络）。
 *
 * 这段判断是**唯一**能拦住「把全库钥匙挂到网页上」的地方，
 * 所以要逐条钉住：配好了、没配、模板占位、拿成 Secret key。
 */

import { describe, expect, it } from "vitest";
import { evaluateConfig, isSecretKey } from "./cloud";

/*
 * ⚠️ 这个文件里的地址和钥匙都是**形状相同、内容是假的**的样例值，
 * 不许出现真实项目的信息。
 */
const SAMPLE_URL = "https://sampleprojectref.supabase.co";
const SAMPLE_KEY = "sb_publishable_sample-key-not-a-real-one";

/** 把一段载荷载进一个假 JWT 里（老格式的 anon / service_role 就是这种） */
function fakeJwt(payload: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${body}.c2ln`;
}

describe("云端配置 · 钥匙的安全检查", () => {
  it("配好了没有：四种情况各归各位", () => {
    const good = evaluateConfig({
      VITE_SUPABASE_URL: SAMPLE_URL,
      VITE_SUPABASE_ANON_KEY: SAMPLE_KEY,
    });
    expect(good.problem).toBeNull();
    expect(good.config?.url).toBe(SAMPLE_URL);
    expect(good.config?.anonKey).toBe(SAMPLE_KEY);

    // 老格式的 anon（JWT）同样要能用 —— 老项目还在用
    const legacy = evaluateConfig({
      VITE_SUPABASE_URL: "https://abcdefgh.supabase.co",
      VITE_SUPABASE_ANON_KEY: fakeJwt({ role: "anon" }),
    });
    expect(legacy.problem).toBeNull();
    expect(legacy.config).not.toBeNull();

    // 少一个就是「没配」；只写了空格也不能算配好
    expect(evaluateConfig({ VITE_SUPABASE_URL: "https://abcdefgh.supabase.co" }).problem).toBe("missing");
    expect(evaluateConfig({}).problem).toBe("missing");
    expect(
      evaluateConfig({
        VITE_SUPABASE_URL: "https://abcdefgh.supabase.co",
        VITE_SUPABASE_ANON_KEY: "   ",
      }).problem,
    ).toBe("missing");

    // 还是 .env.example 里的模板占位值
    expect(
      evaluateConfig({
        VITE_SUPABASE_URL: "https://xxxxxxxxxxxx.supabase.co",
        VITE_SUPABASE_ANON_KEY: "sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxx",
      }).problem,
    ).toBe("placeholder");

    // 拿错钥匙：**不许**被当成配置好了、更不许拿去连
    const wrong = evaluateConfig({
      VITE_SUPABASE_URL: "https://abcdefgh.supabase.co",
      VITE_SUPABASE_ANON_KEY: "sb_secret_abcdefgh",
    });
    expect(wrong.problem).toBe("secretKey");
    expect(wrong.config).toBeNull();

    expect(
      evaluateConfig({
        VITE_SUPABASE_URL: "https://abcdefgh.supabase.co",
        VITE_SUPABASE_ANON_KEY: fakeJwt({ role: "service_role" }),
      }).problem,
    ).toBe("secretKey");
  });

  it("Secret key 必须被认出来并拦住（拿错了等于把全库钥匙挂在网页上）", () => {
    expect(isSecretKey("sb_secret_abcdefg")).toBe(true);
    expect(isSecretKey(SAMPLE_KEY)).toBe(false);

    // 老格式：一段 JWT，payload 里写着角色
    expect(isSecretKey(fakeJwt({ role: "service_role" }))).toBe(true);
    expect(isSecretKey(fakeJwt({ role: "anon" }))).toBe(false);

    // 认不出来的一律不误判（宁可让它去连、由服务端拒绝，也不要拦住正常配置）
    expect(isSecretKey("")).toBe(false);
    expect(isSecretKey("随便一段字符串")).toBe(false);
    expect(isSecretKey("eyJhbGciOiJIUzI1NiJ9.not-base64!!.sig")).toBe(false);
  });
});
