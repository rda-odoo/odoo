# -*- coding: utf-8 -*-
{
    'name': 'Screen Sharing',
    'version': '1.0',
    'category': 'Tools',
    'description': """ """,
    'author': 'OpenERP SA',
    'website': 'http://openerp.com',
    'depends': ['im_chat'],
    'update_xml': [
    ],
    'js' : [
        'static/lib/mutation-summary/mutation_summary.js',
        'static/lib/mutation-summary/tree_mirror.js',
        #'static/lib/smt2/smt-aux.js',
        #'static/lib/smt2/wz_jsgraphics.js',
        #'static/lib/mouse_track.js',
        #'static/src/js/screen_record.js',
    ],
    'installable': True,
    'auto_install': False,
    'application': True,
}

# vim:expandtab:smartindent:tabstop=4:softtabstop=4:shiftwidth=4:
