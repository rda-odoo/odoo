# -*- coding: utf-8 -*-
import base64
import datetime
import json
import logging
import select
import threading
import time
import uuid

import openerp
from openerp.http import request

_logger = logging.getLogger(__name__)

TIMEOUT = 50
TIMEOUT = 15

"""
openerp.jsonRpc('/longpolling/poll','call',{"channels":["c1"]}).then(function(r){console.log(r)});
openerp.jsonRpc('/longpolling/send','call',{"channel":"c1","message":"m1"}).then(function(r){console.log(r)});
openerp.jsonRpc('/longpolling/send','call',{"channel":"c2","message":"m2"}).then(function(r){console.log(r)});
"""

#----------------------------------------------------------
# Bus
#----------------------------------------------------------
class Bus(object):
    def __init__(self):
        self.channels = {}
        self.notifications = []

    def hashable(self, key):
        if isinstance(key, list):
            key = tuple(key)
        return key

    def sendmany(self, notifications):
        if notifications:
            # prepend ts
            ts = time.time()
            notifications = [(ts, self.hashable(channel), message) for channel, message in notifications]
            cr = openerp.sql_db.db_connect('postgres').cursor()
            cr.execute("notify imbus, %s", (json.dumps(notifications),))
            cr.commit()
            cr.close()

    def sendone(self, channel, message):
        self.sendmany([[channel, message]])

    def poll(self, channels, last, timeout=TIMEOUT):
        # Dont hang ctrl-c for a poll request, we need to bypass private
        # attribute access because we dont know before starting the thread that
        # it will handle a longpolling request
        if not openerp.evented:
            threading.current_thread()._Thread__daemonic = True

        channels = [self.hashable(c) for c in channels]

        # immediatly returns if past notifications exist
        r = [n for n in self.notifications if n[0] > last and n[1] in channels]
        if r:
            return r

        # or wait for future ones
        event = self.Event()
        for c in channels:
            self.channels.setdefault(self.hashable(c), []).append(event)
        try:
            print "Bus.poll", threading.current_thread(), channels
            event.wait(timeout=timeout)
            notifications = event.notifications
            r = [n for n in notifications if n[1] in channels]
        except Exception:
            # timeout
            pass
        return r

    def dispatch(self, notifications):
        # gc and queue
        ts = notifications[0][0]
        self.notifications = [n for n in self.notifications if n[0] > ts - TIMEOUT] + notifications
        print self.notifications
        # dispatch to local threads/greenlets
        events = set()
        for n in notifications:
            c = self.hashable(n[1])
            events.update(self.channels.pop(c,[]))
        for e in events:
            e.notifications = notifications
            e.set()

    def loop(self):
        """ Dispatch postgres notifications to the relevant polling threads/greenlets """
        _logger.info("Bus.loop listen imbus on db postgres")
        cr = openerp.sql_db.db_connect('postgres').cursor()
        try:
            conn = cr._cnx
            cr.execute("listen imbus")
            cr.commit();
            while True:
                if select.select([conn], [], [], TIMEOUT) == ([],[],[]):
                    pass
                else:
                    conn.poll()
                    notifications=[]
                    while conn.notifies:
                        notifications.extend(json.loads(conn.notifies.pop().payload))
                    self.dispatch(notifications)
        finally:
            cr.close()

    def run(self):
        while True:
            try:
                self.loop()
            except Exception, e:
                _logger.exception("Bus.loop error, sleep and retry")
                time.sleep(TIMEOUT)

    def start(self):
        if openerp.multi_process:
            # disabled in prefork mode
            return
        elif openerp.evented:
            # gevent mode
            import gevent
            self.Event = gevent.event.Event
            gevent.spawn(self.run)
        else:
            # threaded mode
            self.Event = threading.Event
            t = threading.Thread(name="%s.Bus" % __name__, target=self.run)
            t.daemon = True
            t.start()
        return self

bus = Bus().start()

#----------------------------------------------------------
# Controller
#----------------------------------------------------------
class Controller(openerp.http.Controller):
    # TODO: INSECURE TEST controller bypassing security REMOVE ME
    @openerp.http.route('/longpolling/send', type="json", auth="none")
    def send(self, channel, message):
        return bus.sendone(channel, message)

    # override to add channels
    def _poll(self, channels, last):
        return bus.poll(channels, last)

    @openerp.http.route('/longpolling/poll', type="json", auth="none")
    def poll(self, channels, last):
        if not bus:
            raise Exception("im.Bus unavailable")
        if [c for c in channels if not isinstance(c, basestring)]:
            raise Exception("im.Bus only string channels are allowed.")
        return self._poll(channels, last)

# vim:et:
