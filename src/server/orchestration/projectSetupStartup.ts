import type { MasterSession } from "../master/session.ts";

/** MasterSession normally absorbs launch failures and schedules a restart.
 * Initial setup must prove one successful launch before exposing Task authoring. */
export async function startConfirmedSetupMaster(session:MasterSession):Promise<void> {
  await session.start();
  if(session.state!=="idle"){
    await session.stop();
    throw Error("Project setup Master startup did not reach ready state");
  }
}
