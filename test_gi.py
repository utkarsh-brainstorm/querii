import os, sys

def test_gi():
    system_paths = ["/usr/lib/girepository-1.0", "/usr/lib/x86_64-linux-gnu/girepository-1.0"]
    current = os.environ.get("GI_TYPELIB_PATH", "")
    os.environ["GI_TYPELIB_PATH"] = ":".join([current] + [p for p in system_paths if os.path.exists(p)]).strip(":")
    print("GI_TYPELIB_PATH is now:", os.environ["GI_TYPELIB_PATH"])
    
    try:
        import gi
        gi.require_version("WebKit2", "4.1")
        from gi.repository import WebKit2
        print("Successfully loaded WebKit2 4.1 from system!")
    except Exception as e:
        print("Failed to load WebKit2:", e)

if __name__ == "__main__":
    test_gi()
