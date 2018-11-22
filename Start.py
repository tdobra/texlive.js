#!/usr/bin/env python3

import http.server
import socketserver
import webbrowser
import threading

PORT = 8000
MAXPORT = 8099  # Maximum port number to try

# Start server
Handler = http.server.SimpleHTTPRequestHandler
portok = False
while portok == False:
    try:
        httpd = socketserver.TCPServer(("", PORT), Handler)
    except OSError as err:
        if err.errno == 48:
            # Socket in use
            if PORT >= MAXPORT:
                print("ERROR: Could not find a port for server.")
                break
                
            PORT = PORT + 1

    else:
        portok = True


if portok == True:
    server_thread = threading.Thread(target=httpd.serve_forever)
    # Exit the server thread when the main thread terminates
    server_thread.daemon = True
    server_thread.start()

    # Display status
    urlstr = "http://localhost:" + str(PORT)
    print("Open " + urlstr + " in your web browser.")
    print("Press Enter to exit.")
    webbrowser.open(urlstr)

    # Wait for user
    input()

    # Exit
    httpd.shutdown()
    httpd.server_close()
