using System;
using System.Text;
using System.Runtime.InteropServices;
public static class VelloraTestWindow {
 public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr data);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int max);
 [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
 [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 public static string[] Observe(int processId) {
   string title="";uint dpi=0;int width=0,height=0;bool visible=false;
   EnumWindows((hwnd,data)=>{uint pid;GetWindowThreadProcessId(hwnd,out pid);if(pid!=(uint)processId)return true;
     var text=new StringBuilder(2048);GetWindowText(hwnd,text,text.Capacity);var value=text.ToString();
     if(value.Contains("Vellora") && value.Length>title.Length){title=value;visible=IsWindowVisible(hwnd);dpi=GetDpiForWindow(hwnd);Rect rect;if(GetClientRect(hwnd,out rect)){width=rect.right-rect.left;height=rect.bottom-rect.top;}}return true;},IntPtr.Zero);
   return new[]{title,dpi.ToString(),width.ToString(),height.ToString(),visible.ToString()};
 }
}
