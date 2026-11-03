import { ScreenError, SCREEN_MAX_DISPLAYS, validateScreenImages, validDisplayId, type ScreenPort, type ScreenDisplay } from '../src/screens.js';
/** Structural API keeps OS capture testable without starting Electron or taking real screenshots. */
export interface CaptureThumbnail { isEmpty(): boolean; getSize(): {width:number;height:number}; toJPEG(quality:number): Buffer; resize(options:{width:number;height:number;quality:'best'}): CaptureThumbnail }
export interface ScreenAPI {
  displays(): { id: number; size: { width: number; height: number }; scaleFactor: number }[];
  primaryId(): number;
  sources(): Promise<{ display_id: string; thumbnail: CaptureThumbnail }[]>;
  permission(): string;
  locked(): boolean;
}
export class DesktopScreens implements ScreenPort {
  private busy = false;
  private timedOut = false;
  constructor(private api: ScreenAPI, private enabled: () => boolean, private platform = process.platform, private wayland = Boolean(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland'), private timeoutMs = 15000) {}
  private check() {
    if (!this.enabled()) throw new ScreenError('SCREEN_DISABLED');
    if (this.timedOut) throw new ScreenError('SCREEN_RESTART_REQUIRED');
    if (this.api.locked()) throw new ScreenError('SCREEN_LOCKED');
    if (!['darwin','win32','linux'].includes(this.platform)) throw new ScreenError('SCREEN_UNAVAILABLE');
  }
  private displays(): ScreenDisplay[] {
    const displays = this.api.displays();
    if (!displays.length || displays.length > SCREEN_MAX_DISPLAYS) throw new ScreenError('SCREEN_LIMIT_EXCEEDED');
    const primary = this.api.primaryId();
    return displays.map(d => ({id:String(d.id),width:d.size.width,height:d.size.height,scaleFactor:d.scaleFactor,primary:d.id===primary}));
  }
  async list() { this.check(); return {displays:this.displays(),platform:this.platform,selectionSupported:!this.wayland,permission:this.api.permission()}; }
  async capture(displayId: string) {
    this.check();
    if (!validDisplayId(displayId)) throw new ScreenError('SCREEN_NOT_FOUND');
    // PipeWire exposes a single portal-selected source, not a reliable display-ID mapping.
    if (this.wayland) throw new ScreenError('SCREEN_SELECTION_UNAVAILABLE');
    if (this.platform === 'darwin' && ['denied','restricted'].includes(this.api.permission())) throw new ScreenError('SCREEN_PERMISSION_DENIED');
    if (this.busy) throw new ScreenError('SCREEN_BUSY');
    const before = this.displays(), selected = displayId === 'all' ? before : before.filter(d => d.id === displayId);
    if (!selected.length) throw new ScreenError('SCREEN_NOT_FOUND');
    this.busy = true;
    try {
      let timer:ReturnType<typeof setTimeout>|undefined;
      let sources:Awaited<ReturnType<ScreenAPI['sources']>>;
      try { sources=await Promise.race([this.api.sources(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{this.timedOut=true;reject(new ScreenError('SCREEN_TIMEOUT'));},this.timeoutMs);})]); }
      finally { if(timer)clearTimeout(timer); }
      // Electron cannot cancel getSources. Late native results are discarded; after
      // a timeout require an app restart instead of accumulating overlapping work.
      this.check();
      if(this.platform==='darwin'&&this.api.permission()!=='granted')throw new ScreenError('SCREEN_PERMISSION_DENIED');
      if (JSON.stringify(before) !== JSON.stringify(this.displays())) throw new ScreenError('SCREEN_LAYOUT_CHANGED');
      const images = selected.map(d => {
        const matches = sources.filter(s => s.display_id === d.id);
        if (matches.length !== 1 || matches[0]!.thumbnail.isEmpty()) throw new ScreenError('SCREEN_SELECTION_UNAVAILABLE');
        let thumbnail = matches[0]!.thumbnail, size = thumbnail.getSize();
        if(size.width>2560||size.height>2560){const ratio=2560/Math.max(size.width,size.height);thumbnail=thumbnail.resize({width:Math.max(1,Math.floor(size.width*ratio)),height:Math.max(1,Math.floor(size.height*ratio)),quality:'best'});size=thumbnail.getSize();}
        return {displayId:d.id,width:size.width,height:size.height,jpeg:thumbnail.toJPEG(85)};
      });
      return validateScreenImages(images, displayId);
    } catch (error) { if (error instanceof ScreenError) throw error; throw new ScreenError('SCREEN_UNAVAILABLE'); }
    finally { this.busy = false; }
  }
}
