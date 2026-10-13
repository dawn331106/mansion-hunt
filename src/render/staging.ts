import type * as THREE from 'three';

/**
 * Hold loaded models out of sight until their shaders are ready.
 *
 * A material's shader is compiled the first time something wearing it is
 * drawn, and compiling stops the frame. With a dozen models arriving in the
 * first seconds of a match, each one appearing cost a visible stall. So each
 * loader puts its model in the scene hidden, the renderer compiles the whole
 * scene in the background once everything is in, and only then does the
 * stage swap the plain stand-in boxes for the models — in one frame, with
 * nothing left to compile.
 */
export class Stage {
  private readonly held: THREE.Object3D[] = [];
  private readonly standIns: THREE.Object3D[] = [];
  private readonly pending: Promise<unknown>[] = [];

  /** Keep a loaded model hidden until `reveal`. */
  hold(obj: THREE.Object3D): void {
    obj.visible = false;
    this.held.push(obj);
  }

  /** Something shown only until `reveal`. */
  standIn(obj: THREE.Object3D): void {
    this.standIns.push(obj);
  }

  /** A load the stage should wait for. A failed load is waited for too. */
  wait<T>(p: Promise<T>): Promise<T> {
    this.pending.push(p);
    return p;
  }

  /** Settles once every load registered so far has finished, or failed. */
  ready(): Promise<void> {
    return Promise.allSettled(this.pending).then(() => undefined);
  }

  reveal(): void {
    for (const o of this.held) o.visible = true;
    for (const o of this.standIns) o.visible = false;
  }
}
