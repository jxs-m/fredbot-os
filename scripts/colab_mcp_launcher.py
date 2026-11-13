#!/usr/bin/env python3
import sys
import subprocess
import webbrowser
import warnings

# Suppress deprecation warnings
warnings.filterwarnings("ignore")

# Patch webbrowser on Linux to prevent xdg-open from printing to stdout
# (which corrupts the MCP JSON-RPC stdio protocol with 'Abrindo em uma sessão...')
if hasattr(webbrowser, "BackgroundBrowser"):
    orig_bg_open = webbrowser.BackgroundBrowser.open
    def safe_bg_open(self, url, new=0, autoraise=True):
        cmdline = [self.name] + [arg.replace("%s", url) for arg in self.args]
        try:
            p = subprocess.Popen(
                cmdline,
                close_fds=True,
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return p.poll() is None
        except OSError:
            return False
    webbrowser.BackgroundBrowser.open = safe_bg_open

if hasattr(webbrowser, "GenericBrowser"):
    orig_gen_open = webbrowser.GenericBrowser.open
    def safe_gen_open(self, url, new=0, autoraise=True):
        cmdline = [self.name] + [arg.replace("%s", url) for arg in self.args]
        try:
            p = subprocess.Popen(
                cmdline,
                close_fds=True,
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return p.poll() is None
        except OSError:
            return False
    webbrowser.GenericBrowser.open = safe_gen_open

from colab_mcp import main

if __name__ == "__main__":
    main()
