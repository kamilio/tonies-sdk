import { defineGroup } from "toolcraft";
import { accountCommands, apiCommands, authCommands, contentCommands, creativeCommands, householdCommands, rawCommands, syncCommands, tonieboxCommands, tuneCommands } from "./commands.js";

export const root = defineGroup({
  name: "tonies",
  description: "Tonies cloud management and Toniebox realtime controls",
  children: [
    apiCommands,
    authCommands,
    accountCommands,
    householdCommands,
    creativeCommands,
    contentCommands,
    tonieboxCommands,
    tuneCommands,
    syncCommands,
    rawCommands
  ]
});
