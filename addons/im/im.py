# -*- coding: utf-8 -*-
import datetime
import json
import logging
import select
import threading
import time
import random

import simplejson
import openerp
from openerp.osv import osv, fields
from openerp.http import request
from openerp.tools.misc import DEFAULT_SERVER_DATETIME_FORMAT

_logger = logging.getLogger(__name__)

TIMEOUT = 50

"""
openerp.jsonRpc('/longpolling/poll','call',{"channels":["c1"],last:0}).then(function(r){console.log(r)});
openerp.jsonRpc('/longpolling/send','call',{"channel":"c1","message":"m1"}).then(function(r){console.log(r)});
openerp.jsonRpc('/longpolling/send','call',{"channel":"c2","message":"m2"}).then(function(r){console.log(r)});
"""

#----------------------------------------------------------
# Bus
#----------------------------------------------------------
def json_dump(v):
    return simplejson.dumps(v, separators=(',', ':'))

def hashable(key):
    if isinstance(key, list):
        key = tuple(key)
    return key

class ImBus(osv.Model):
    _name = 'im.bus'
    _columns = {
        'id' : fields.integer('Id'),
        'create_date' : fields.datetime('Create date'),
        'channel' : fields.char('Channel'),
        'message' : fields.char('Message'),
    }

    def gc(self, cr, uid):
        timeout_ago = datetime.datetime.now()-datetime.timedelta(seconds=TIMEOUT*2)
        domain = [('create_date', '<', timeout_ago.strftime(DEFAULT_SERVER_DATETIME_FORMAT))]
        ids  = self.search(cr, uid, domain)
        self.unlink(cr, uid, ids)

    def sendmany(self, cr, uid, notifications):
        channels = set()
        for channel, message in notifications:
            channels.add(channel)
            values = {
                "channel" : json_dump(channel),
                "message" : json_dump(message)
            }
            self.pool['im.bus'].create(cr, uid, values)
            if random.random() < 0.01:
                self.gc(cr, uid)
        if channels:
            with openerp.sql_db.db_connect('postgres').cursor() as cr2:
                cr2.execute("notify imbus, %s", (json_dump(list(channels)),))

    def sendone(self, cr, uid, channel, message):
        self.sendmany(cr, uid, [[channel, message]])

    def poll(self, cr, uid, channels, last=0):
        # first polll returns the last_id
        if last == 0:
            cr.execute('SELECT COALESCE(MAX(id),0)+1 FROM ' + self._table)
            return [{'id': cr.fetchone()[0]}]
        # else returns the unread notifications
        channels = [json_dump(c) for c in channels]
        domain = [('id','>',last), ('channel','in',channels)]
        notifications = self.search_read(cr, uid, domain)
        return [{"id":notif["id"], "channel": simplejson.loads(notif["channel"]), "message":simplejson.loads(notif["message"])} for notif in notifications]

class ImDispatch(object):
    def __init__(self):
        self.channels = {}

    def poll(self, dbname, channels, last, timeout=TIMEOUT):
        # Dont hang ctrl-c for a poll request, we need to bypass private
        # attribute access because we dont know before starting the thread that
        # it will handle a longpolling request
        if not openerp.evented:
            threading.current_thread()._Thread__daemonic = True

        registry = openerp.registry(dbname)

        # immediatly returns if past notifications exist
        with registry.cursor() as cr:
            notifications = registry['im.bus'].poll(cr, openerp.SUPERUSER_ID, channels, last)
        # or wait for future ones
        if not notifications:
            event = self.Event()
            for c in channels:
                self.channels.setdefault(hashable(c), []).append(event)
            try:
                event.wait(timeout=timeout)
                with registry.cursor() as cr:
                    notifications = registry['im.bus'].poll(cr, openerp.SUPERUSER_ID, channels, last)
            except Exception:
                # timeout
                pass
        return notifications

    def loop(self):
        """ Dispatch postgres notifications to the relevant polling threads/greenlets """
        _logger.info("Bus.loop listen imbus on db postgres")
        with openerp.sql_db.db_connect('postgres').cursor() as cr:
            conn = cr._cnx
            cr.execute("listen imbus")
            cr.commit();
            while True:
                if select.select([conn], [], [], TIMEOUT) == ([],[],[]):
                    pass
                else:
                    conn.poll()
                    channels = []
                    while conn.notifies:
                        channels.extend(json.loads(conn.notifies.pop().payload))
                    # dispatch to local threads/greenlets
                    events = set()
                    for c in channels:
                        events.update(self.channels.pop(hashable(c),[]))
                    for e in events:
                        e.set()

    def run(self):
        while True:
            try:
                self.loop()
            except Exception, e:
                _logger.exception("Bus.loop error, sleep and retry")
                time.sleep(TIMEOUT)

    def start(self):
        if openerp.evented:
            # gevent mode
            import gevent
            self.Event = gevent.event.Event
            gevent.spawn(self.run)
        elif openerp.multi_process:
            # disabled in prefork mode
            return
        else:
            # threaded mode
            self.Event = threading.Event
            t = threading.Thread(name="%s.Bus" % __name__, target=self.run)
            t.daemon = True
            t.start()
        return self

dispatch = ImDispatch().start()

#----------------------------------------------------------
# Controller
#----------------------------------------------------------
class Controller(openerp.http.Controller):
    @openerp.http.route('/longpolling/send', type="json", auth="public")
    def send(self, channel, message):
        if not isinstance(channel, basestring):
            raise Exception("im.Bus only string channels are allowed.")
        registry, cr, uid, context = request.registry, request.cr, request.session.uid, request.context
        return registry['im.bus'].sendone(cr, uid, channel, message)

    # override to add channels
    def _poll(self, dbname, channels, last, options):
        # TODO close request.cr
        return dispatch.poll(dbname, channels, last)

    @openerp.http.route('/longpolling/poll', type="json", auth="public")
    def poll(self, channels, last, options=None):
        if options is None:
            options = {}
        if not dispatch:
            raise Exception("im.Bus unavailable")
        if [c for c in channels if not isinstance(c, basestring)]:
            raise Exception("im.Bus only string channels are allowed.")
        return self._poll(request.db, channels, last, options)

# vim:et:
