import assert from "node:assert/strict";
import { activationArguments, appUserModelId, selectApplicationId } from "../src/desktop-launcher.mjs";

const manifest = {
  packageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
  applications: [
    { Id: "CodexCoreCommandRunner", Executable: "app/resources/codex-command-runner.exe" },
    { Id: "App", Executable: "app/ChatGPT.exe" },
  ],
};
assert.equal(selectApplicationId(manifest.applications), "App");
assert.equal(appUserModelId(manifest), "OpenAI.Codex_2p2nqsd0c76g0!App");

assert.equal(selectApplicationId([{ Id: "App", Executable: "app/ChatGPT.exe" }]), "App");
assert.equal(selectApplicationId([{ Id: "App", Executable: "app/CHATGPT.EXE" }]), "App");
assert.equal(selectApplicationId([{ Id: "Only", Executable: "app/Codex.exe" }]), "Only");
assert.throws(() => selectApplicationId([]));
assert.throws(() => selectApplicationId(null));

assert.equal(activationArguments(null), "");
assert.equal(activationArguments(9237), "--remote-debugging-port=9237 --remote-debugging-address=127.0.0.1");
console.log("desktop launcher: ok");
