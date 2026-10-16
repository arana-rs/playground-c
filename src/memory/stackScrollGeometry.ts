export interface StackScrollFollowGeometry {
  readonly currentScrollLeft: number;
  readonly maxScrollLeft: number;
  readonly visibleLeft: number;
  readonly visibleRight: number;
  readonly elementLeft: number;
  readonly elementRight: number;
  readonly margin: number;
}

export interface StackScrollFollowTarget {
  readonly scrollLeft: number;
  readonly alreadyVisible: boolean;
  readonly canFit: boolean;
}

/** Keep one target anchored while allowing its completion callback to run only once. */
export class StackScrollFollowAnchor<T> {
  readonly element: T;
  readonly margin: number;
  private targetScrollLeft = 0;
  private targetCanFit = true;
  private geometryInvalidated = true;
  private completion?: (fullyVisible: boolean) => void;
  private active = true;

  constructor(
    element: T,
    margin: number,
    onSettled?: (fullyVisible: boolean) => void,
  ) {
    this.element = element;
    this.margin = margin;
    this.completion = onSettled;
  }

  get isActive() {
    return this.active;
  }

  get scrollLeftTarget() {
    return this.targetScrollLeft;
  }

  get canFit() {
    return this.targetCanFit;
  }

  invalidateGeometry() {
    if (this.active) this.geometryInvalidated = true;
  }

  plan(geometry: Omit<StackScrollFollowGeometry, 'margin'>): StackScrollFollowTarget | null {
    if (!this.active || (!this.geometryInvalidated && !this.targetCanFit)) return null;
    const target = computeStackScrollFollowTarget({ ...geometry, margin: this.margin });
    this.targetScrollLeft = target.scrollLeft;
    this.targetCanFit = target.canFit;
    this.geometryInvalidated = false;
    if (target.alreadyVisible) this.confirmVisible(true);
    return target;
  }

  confirmVisible(fullyVisible: boolean) {
    if (!this.active || !fullyVisible) return;
    const completion = this.completion;
    this.completion = undefined;
    completion?.(true);
  }

  cancel(notify = true) {
    if (!this.active) return;
    this.active = false;
    const completion = this.completion;
    this.completion = undefined;
    if (notify) completion?.(false);
  }
}

/** Compute the smallest horizontal scroll that reveals the target using current geometry. */
export function computeStackScrollFollowTarget(
  geometry: StackScrollFollowGeometry,
): StackScrollFollowTarget {
  const visibleLeft = geometry.visibleLeft + geometry.margin;
  const visibleRight = geometry.visibleRight - geometry.margin;
  const canFit = geometry.elementRight - geometry.elementLeft <= visibleRight - visibleLeft + 0.5;
  const alreadyVisible = geometry.elementLeft >= visibleLeft - 0.5
    && geometry.elementRight <= visibleRight + 0.5;
  if (alreadyVisible) return { scrollLeft: geometry.currentScrollLeft, alreadyVisible: true, canFit };

  let adjustment = 0;
  if (geometry.elementLeft < visibleLeft) adjustment = geometry.elementLeft - visibleLeft;
  else if (geometry.elementRight > visibleRight) adjustment = geometry.elementRight - visibleRight;

  const scrollLeft = Math.max(
    0,
    Math.min(geometry.maxScrollLeft, geometry.currentScrollLeft + adjustment),
  );
  return { scrollLeft, alreadyVisible: false, canFit };
}
