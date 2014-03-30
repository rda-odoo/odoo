# -*- coding: utf-8 -*-
import base64
import datetime
import json
import logging
import select
import threading
import time
import uuid

import simplejson

import openerp
from openerp.http import request
from openerp.osv import osv, fields, expression
from openerp.tools.misc import DEFAULT_SERVER_DATETIME_FORMAT
from openerp.addons.im.im import TIMEOUT, bus

_logger = logging.getLogger(__name__)

DISCONNECTION_TIMER = TIMEOUT + 5

#----------------------------------------------------------
# Controllers
#----------------------------------------------------------

class Controller(openerp.addons.im.im.Controller):
    def _poll(self, channels):
        if request.session.uid:
            #TODO: signal presence with a special cr
            #registry.get('res.users').im_connect(cr, uid, context=context)
            # listen to connection and disconnections
            channels.append((request.db,'users'))
        return super(Controller, self)._poll(channels)

    @openerp.http.route('/im/init', type="json", auth="none")
    def init(self, uuids=None):
        # TODO call get_messages()
        pass

    @openerp.http.route('/im/post', type="json", auth="none")
    def post(self, uuid, message_type, message_content):
        registry, cr, uid, context = request.registry, request.cr, request.session.uid, request.context
        message_id = registry["im.message"].post(cr, uid, uuid, message_type, message_content, context=context)
        return message_id

    @openerp.http.route('/im/image', type='http', auth="none")
    def image(self, uuid, user_id):
        registry, cr = request.registry, request.cr

        # default image
        image_b64 = 'R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='

        # get the session
        Session = registry.get("im.session")
        session_ids = Session.search(cr, 1, [('uuid','=',uuid), ('user_ids','=',user_id)])
        for s in Session.browse(cr, 1, session_ids, context=context):
            # get the image of the user
            u = registry.get("res.users").read(cr, 1, [user_id], ["image_small"])[0]
            image_base64 = res["image_small"]

        # built the response
        image_data = base64.b64decode(image_b64)
        headers = [('Content-Type', 'image/png')]
        headers.append(('Content-Length', len(image_data)))
        return request.make_response(image_data, headers)

#----------------------------------------------------------
# Models
#----------------------------------------------------------

class im_session(osv.Model):
    _order = 'id desc'
    _name = 'im.session'

    _rec_name = 'uuid'

    # TODO transform in function field 'header'
    def _get_fullname(self, cr, uid, ids, fields, context={}):
        """ built the header of a given session """
        name = []
        if (uid is not None) and session.name:
            name.append(session.name)
        for u in session.user_ids:
            if u.id != uid:
                name.append(u.name)

    _columns = {
        'uuid': fields.char('UUID', size=50, select=True),
        'name' : fields.char('Name'),
        'message_ids': fields.one2many('im.message', 'to_id', 'Messages'),
        'user_ids': fields.many2many('res.users'),
        #'fullname' : fields.function(_get_header),
    }
    _defaults = {
        'uuid': lambda *args: '%s' % uuid.uuid4(),
        'name' : "",
    }

    def is_private(self, cr, uid, session_id, context=None):
        """ return true if the session is private between users no external messages """
        mess_ids = self.pool["im.message"].search(cr, uid, [('to_id','=',session_id),('from_id','=',None)], context=context)
        return len(mess_ids) == 0

    def session_info(self, cr, uid, session_id, context={}):
        session = self.browse(cr, uid, session_id, context=context)
        users_infos = self.pool["res.users"].im_users_status(cr, 1, [u.id for u in session.user_ids], context=context)
        return {
            'uuid': session.uuid,
            'name': session.name,
            'users' : users_infos
        }

    def session_get(self, cr, uid, user_to, context={}):
        """ returns the canonical session between 2 users, create it if needed."""
        session_id = False
        if user_to:
            # FP Note: does the ORM allows something better than this? == on many2many
            sids = self.search(cr, uid, [('user_ids','in',[user_to]),('user_ids','in',[uid])], context=context, limit=1)
            for session in self.browse(cr, uid, sids, context=context):
                if len(session.user_ids) == 2 and self.is_private(cr, uid, session.id, context):
                    session_id = session.id
                    break
            else:
                session_id = self.create(cr, uid, { 'user_ids': [(6,0, (user_to, uid))] }, context=context)
        return self.session_info(cr, uid, session_id, context=context)

    def add_user(self, cr, uid, session_id, user_id, context=None):
        """ add the given user to the given session """
        session = self.browse(cr, uid, session_id, context=context)
        if user_id not in [u.id for u in session.user_ids]:
            self.write(cr, uid, [session_id], {'user_ids': [(4, user_id)]}, context=context)
            return True
        return False

class im_message(osv.Model):
    _name = 'im.message'
    _order = "id desc"
    _columns = {
        'from_id': fields.many2one('res.users', 'Author', required=False),
        'to_id': fields.many2one('im.session', 'Session To', required=True, select=True, ondelete='cascade'),
        'date': fields.datetime('Date', required=True, select=True),
        'type': fields.selection([('message','Message'), ('add_user','Add User to Session')], 'Type'),
        'message': fields.char('Message', required=True),
    }
    _defaults = {
        'date': lambda *args: datetime.datetime.now().strftime(DEFAULT_SERVER_DATETIME_FORMAT),
        'type' : 'message',
    }

    def get_messages(self, cr, uid, last=None, uuids=None, context=None):
        """ get the unread messages."""
        notifications = []

        domain = []
        if uid:
            domain = [('to_id.user_ids', 'in', (uid,))] + domain
        else:
            domain = [('to_id.uuid', 'in', uuids)] + domain

        # TODO replace last by last 30min or something smarter (max 20 lines per sessions)
        #    last = last or user.im_last_received
        #if last:
        #    domain.append(('id','>',last))

        mess_ids = self.search(cr, openerp.SUPERUSER_ID, domain, context=context, order='id asc')
        messages = self.browse(cr, openerp.SUPERUSER_ID, mess_ids, context=context)

        sessions = set()
        for m in messages:
            data = {
                'id': m.id,
                'from_id': m.from_id and (m.from_id.id, m.from_id.name) or (False, 'Anonymous'),
                'to_id': m.to_id.uuid,
                'date': m.date,
                'type' : m.type,
                'message': m.message,
            }
            sessions.add(m.to_id.uuid)
            notifications.append([m.to_id.uuid, data])
            last = max(last, m.id)

        for s_uuid in sessions:
            session_info = self.pool.get('im.session').header_get(cr, uid, s_uuid, context=context)
            notifications.insert(0,[s_uuid, session_info])

        #user = self.pool['res.users'].browse(cr, openerp.SUPERUSER_ID, uid, context=context)
        #if user:
        #    if (not user.im_last_received) or (user.im_last_received < last):
        #        users.write(cr, openerp.SUPERUSER_ID, [uid], {'im_last_received': last}, context=context)

        return notifications

    def post(self, cr, uid, uuid, message_type, message_content, context=None):
        """ post a message, execute the corresponding actions (if technical message) and return the message id """
        message_id = False

        Session = self.pool['im.session']
        session_ids = Session.search(cr, openerp.SUPERUSER_ID, [('uuid','=',uuid)], context=context)
        for session in Session.browse(cr, openerp.SUPERUSER_ID, session_ids, context=context):
            notifications = []
            data = {
                "from_id" : uid,
                "to_id" : session.id,
                "type" : message_type,
                "message" : message_content,
            }
            if message_type == "add_user":
                # message type adduser
                # only if i'm a member of the session
                if uid in [u.id for u in session.user_ids]:
                    user_id = simplejson.loads(message_content)
                    if Session.add_user(cr, openerp.SUPERUSER_ID, session.id, user_id, context=context):
                        user_status = self.pool["res.users"].im_users_status(cr, openerp.SUPERUSER_ID, [user_id], context=context)
                        notifications.extend(user_status)
                        notifications.append([uuid, data])
            else:
                # message type message
                # save history
                message_id = self.create(cr, openerp.SUPERUSER_ID, data, context=context)
                notifications.append([uuid, data])
            print "SEnd many", notifications
            bus.sendmany(notifications)
        return message_id

# TODO jerome res.users is not yet refactored

def is_connected(im_status):
    dt = (datetime.datetime.now() - datetime.timedelta(0, DISCONNECTION_TIMER)).strftime('%Y-%m-%d %H:%M:%S')
    return im_status and (im_status > dt)

class res_users(osv.Model):

    _inherit = "res.users"

    _columns = {
        'im_status': fields.datetime(string="IM Latest Connection"),
        'im_last_received': fields.integer('Last IM Message Received'),
    }
    _defaults = {
        'im_status': False,
        'im_last_received': False,
    }

    def __init__(self, pool, cr):
        init_res = super(res_users, self).__init__(pool, cr)
        self.SELF_WRITEABLE_FIELDS = list(self.SELF_WRITEABLE_FIELDS) + ['im_status']
        self.SELF_READABLE_FIELDS = list(self.SELF_READABLE_FIELDS) + ['im_status']
        return init_res

    def im_users_status(self, cr, uid, ids, context=None):
        """ get the status of the user_watch (list of user id) """
        users_status = self.read(cr, openerp.SUPERUSER_ID, ids, ["id", "name", "login", "im_status"], context=context)
        notifications = []
        for u in users_status:
            u['im_status'] = is_connected(u['im_status'])
            notifications.append([[cr.dbname,'users'], u])
        return users_status

    def im_connect(self, cr, uid, context=None):
        user = self.browse(cr, uid, uid, context=context)
        if user:
            if not is_connected(user.im_status):
                notify_channel(cr, "im_channel", {'type': 'status', 'user': user.id})
            self.write(cr, openerp.SUPERUSER_ID, [uid], {'im_status': time.strftime('%Y-%m-%d %H:%M:%S')}, context=context)
            cr.commit()
        return True

    def im_disconnect(self, cr, uid, context=None):
        self.write(cr, openerp.SUPERUSER_ID, [uid], {'im_status': False}, context=context)
        cr.commit()
        notify_channel(cr, "im_channel", {'type': 'status', 'user': uid})
        return True

    def im_search(self, cr, uid, name, limit, context=None):
        group_user_id = self.pool.get("ir.model.data").get_object_reference(cr, uid, 'base', 'group_user')[1]
        dt = (datetime.datetime.now() - datetime.timedelta(0, DISCONNECTION_TIMER)).strftime('%Y-%m-%d %H:%M:%S')
        ids = self.name_search(cr, openerp.SUPERUSER_ID, name, [('id','<>', uid),'|', ('groups_id', 'in', [group_user_id]), ('im_status','>', dt) ], limit=limit, context=context)
        ids = map(lambda x: x[0], ids)
        result = self.read(cr, uid, ids, ['id','name','im_status'], context=context)
        for r in result:
            if r['im_status'] and (r['im_status'] < dt):
                self.im_disconnect(cr, uid, context)
            r['im_status'] = r['im_status'] and (r['im_status'] >= dt) or False
        return result

# vim:et:
