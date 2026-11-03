import { expect, it } from "vitest";
import { chatSubmissionType, chatEnterAction } from "./playerInteraction";

it("uses one send action for the owner's share and keeps questions in discussion", () => {
  expect(chatSubmissionType({ canShare: true, content: "22:20我去了后门，之后听到了响声。" })).toBe("USER_SHARE");
  for (const content of ["林安，你看到了什么？", "我想问一下沈牧", "大家有没有听见声音", "你记得吗", "林安你昨晚在哪", "你说的是谁"]) {
    expect(chatSubmissionType({ canShare: true, content })).toBe("USER_DISCUSSION");
  }
});
it("never turns another phase, role's turn or explicit reply into a completed share", () => {
  expect(chatSubmissionType({ canShare: false, content: "我的经历", mode: "share" })).toBe("USER_DISCUSSION");
  expect(chatSubmissionType({ canShare: true, content: "我也是", replyToMessageId: "message", mode: "share" })).toBe("USER_DISCUSSION");
});
it("allows an explicit purpose when punctuation cannot establish intent", () => {
  expect(chatSubmissionType({ canShare: true, content: "当时我想，怎么会这样？随后我离开了。", mode: "share" })).toBe("USER_SHARE");
  expect(chatSubmissionType({ canShare: true, content: "我想再补充一件事", mode: "discussion" })).toBe("USER_DISCUSSION");
});
it("keeps IME, newline and repeated-send protection for the unified button", () => {
  expect(chatEnterAction({ key: "Enter", isComposing: true }, false, "我的经历", false)).toBe("edit");
  expect(chatEnterAction({ key: "Enter", shiftKey: true }, false, "我的经历", false)).toBe("edit");
  expect(chatEnterAction({ key: "Enter" }, false, "我的经历", true)).toBe("ignore");
  expect(chatEnterAction({ key: "Enter", repeat: true }, false, "我的经历", false)).toBe("ignore");
});
