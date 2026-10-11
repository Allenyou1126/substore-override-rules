import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import { parseScriptParams, zBool, zCsv, zIntIn } from './params';

/**
 * 这些测试覆盖「$arguments → 类型化参数」的全部输入形态与强制转换语义。
 *
 * 输入形态的依据是 Sub-Store 源码：链接 `#` 后要么是 JSON 字符串、要么是 `k=v&k2=v2`，
 * 编辑页给的是对象，即时预览则是 undefined。四种都要能解析。
 */
const Params = z.object({
  enabled: z.optional(zBool()),
  maxNodes: z.optional(zIntIn({ min: 1, max: 50 }, 'maxNodes')),
  keywords: z.optional(zCsv()),
});

describe('parseScriptParams：输入形态', () => {
  it('缺失（undefined）按空对象处理，全部取默认值', () => {
    expect(parseScriptParams(Params, undefined)).toEqual({});
  });

  it('null 按空对象处理', () => {
    expect(parseScriptParams(Params, null)).toEqual({});
  });

  it('空字符串与纯空白按空对象处理', () => {
    expect(parseScriptParams(Params, '')).toEqual({});
    expect(parseScriptParams(Params, '   ')).toEqual({});
  });

  it('接受编辑页传的对象', () => {
    expect(parseScriptParams(Params, { enabled: false, maxNodes: 3 })).toEqual({
      enabled: false,
      maxNodes: 3,
    });
  });

  it('接受 JSON 字符串（链接里的 encodeURIComponent(JSON.stringify(...)) 分支）', () => {
    expect(parseScriptParams(Params, '{"enabled":false,"maxNodes":7}')).toEqual({
      enabled: false,
      maxNodes: 7,
    });
  });

  it('接受 k=v&k2=v2 字符串（链接回退分支），值保持字符串再由 helper 转换', () => {
    expect(parseScriptParams(Params, 'enabled=false&maxNodes=7&keywords=a, b')).toEqual({
      enabled: false,
      maxNodes: 7,
      keywords: ['a', 'b'],
    });
  });

  it('k= 空值按上游语义记成 true', () => {
    expect(parseScriptParams(Params, 'enabled=')).toEqual({ enabled: true });
  });

  it('k 无等号也按上游语义记成 true', () => {
    expect(parseScriptParams(Params, 'enabled')).toEqual({ enabled: true });
  });

  it('百分号编码的值会被解码', () => {
    expect(parseScriptParams(Params, 'keywords=%E9%A6%99%E6%B8%AF,%E6%97%A5%E6%9C%AC')).toEqual({
      keywords: ['香港', '日本'],
    });
  });

  it('残缺的百分号编码不抛错，原样保留', () => {
    expect(parseScriptParams(Params, 'keywords=%zz')).toEqual({ keywords: ['%zz'] });
  });

  it('JSON 字符串被截断时报错，消息里带原文片段', () => {
    expect(() => parseScriptParams(Params, '{"enabled":')).toThrow(/JSON 解析失败/);
  });

  it('JSON 是数组时按「不是对象」报错', () => {
    expect(() => parseScriptParams(Params, '[1,2,3]')).toThrow(/JSON 解析失败/);
  });

  it('数组本身被拒绝', () => {
    // 刻意绕过类型：运行时 `$arguments` 完全可能是个数组（链接写成 `#[1,2]` 之类），
    // 而类型签名不允许。这条测试要的就是「签名之外的值也会被挡住」。
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 见上
    const array = [1, 2] as unknown as Record<string, unknown>;

    expect(() => parseScriptParams(Params, array)).toThrow(/数组/);
  });
});

describe('parseScriptParams：键的取舍', () => {
  it('未声明的键被静默剥离（Sub-Store 自己的 noCache / insecure 就在同一份参数里）', () => {
    expect(parseScriptParams(Params, 'enabled=true&noCache=1&insecure=')).toEqual({
      enabled: true,
    });
  });

  it('只传一部分键时，其余字段不出现在结果里', () => {
    expect(parseScriptParams(Params, { maxNodes: 5 })).toEqual({ maxNodes: 5 });
  });
});

describe('zBool：宽松布尔值', () => {
  const Bool = z.object({ flag: z.optional(zBool()) });
  const parse = (raw: unknown) => parseScriptParams(Bool, { flag: raw });

  it.each(['true', 'TRUE', '  true  ', '1', 'yes', 'on', ''])('%o 为 true', (raw) => {
    expect(parse(raw)).toEqual({ flag: true });
  });

  it.each(['false', 'FALSE', '  False ', '0', 'no', 'off'])('%o 为 false', (raw) => {
    expect(parse(raw)).toEqual({ flag: false });
  });

  it('真布尔值原样通过', () => {
    expect(parse(true)).toEqual({ flag: true });
    expect(parse(false)).toEqual({ flag: false });
  });

  it('不可识别的字符串报错，消息里说出收到的内容', () => {
    expect(() => parse('maybe')).toThrow(/需为 true\/false 之一，收到 "maybe"/);
  });

  it('数字 1 不被当成布尔值（避免隐式真值转换）', () => {
    expect(() => parse(1)).toThrow(/需为 true\/false 之一，收到 1/);
  });
});

describe('zIntIn：整数与区间', () => {
  it('数字字符串会被转成数字', () => {
    expect(parseScriptParams(Params, { maxNodes: '7' })).toEqual({ maxNodes: 7 });
  });

  it('数字原样通过', () => {
    expect(parseScriptParams(Params, { maxNodes: 7 })).toEqual({ maxNodes: 7 });
  });

  it('小数报错并说明需为整数', () => {
    expect(() => parseScriptParams(Params, { maxNodes: 2.5 })).toThrow(
      /maxNodes需为整数，收到 2.5/,
    );
  });

  it('低于下界报错并说明下界', () => {
    expect(() => parseScriptParams(Params, { maxNodes: 0 })).toThrow(/maxNodes需 ≥ 1，收到 0/);
  });

  it('高于上界报错并说明上界', () => {
    expect(() => parseScriptParams(Params, { maxNodes: 999 })).toThrow(/maxNodes需 ≤ 50，收到 999/);
  });

  it('非数字字符串报错', () => {
    expect(() => parseScriptParams(Params, { maxNodes: 'abc' })).toThrow(/maxNodes/);
  });

  it('没有区间的 zIntIn 只校验整数', () => {
    const Spec = z.object({ n: z.optional(zIntIn()) });
    expect(parseScriptParams(Spec, { n: -3 })).toEqual({ n: -3 });
    expect(() => parseScriptParams(Spec, { n: 1.5 })).toThrow(/需为整数/);
  });
});

describe('zCsv：逗号分隔列表', () => {
  const Spec = z.object({ list: z.optional(zCsv()) });
  const parse = (raw: unknown) => parseScriptParams(Spec, { list: raw });

  it('按逗号切分并 trim', () => {
    expect(parse('a, b ,c')).toEqual({ list: ['a', 'b', 'c'] });
  });

  it('丢弃空段', () => {
    expect(parse('a,,b,')).toEqual({ list: ['a', 'b'] });
  });

  it('空字符串得到空数组', () => {
    expect(parse('')).toEqual({ list: [] });
  });

  it('数组原样通过', () => {
    expect(parse(['a', 'b'])).toEqual({ list: ['a', 'b'] });
  });

  it('非字符串的数组元素报错', () => {
    expect(() => parse([1, 2])).toThrow(/list/);
  });
});

describe('错误消息', () => {
  it('多字段错误时逐条列出，并带字段路径', () => {
    let message = '';

    try {
      parseScriptParams(Params, { enabled: 'maybe', maxNodes: 0 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('enabled');
    expect(message).toContain('maxNodes');
    expect(message).toMatch(/需为 true\/false 之一/);
    expect(message).toMatch(/需 ≥ 1/);
  });

  it('抛的是 Error，能被 Sub-Store 的日志打印出消息', () => {
    expect(() => parseScriptParams(Params, { enabled: 'maybe' })).toThrow(Error);
  });
});
