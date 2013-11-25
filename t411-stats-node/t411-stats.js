var program = require('commander');

program
    .version('0.0.1')
    .usage('(-u|--username) <username> (-p|--password) <password> [options]')
    .option('-u, --username <username>', 'set your T411 username')
    .option('-p, --password <password>', 'set your T411 password')
    .option('-i, --initialize <X>', 'initialize with X lastest torrents')
    .option('-F, --flush', 'flush database before proceed')
    .option('-d, --debug', 'display debug logging entries')
    .parse(process.argv);

var async       = require('async');
var mongoose    = require('mongoose');
var request     = require('request');
var qs          = require('qs');
var winston     = require('winston');
var logger = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)({ level: (program.debug)?'debug':'info' })
        //new (winston.transports.File)({ filename: 'somefile.log' })
    ]
});

var mongoUri    = 'mongodb://localhost/';
var dbName      = 't411-stats';
var dbUri       = mongoUri+dbName;

var TStats      = function(dbUri) {
    this.apiCredentials = {
        username    : '',
        password    : ''
    };
    this.dbUri  = dbUri;
    mongoose.connect(dbUri);
    this.db     = mongoose.connection;
    this.db.on('connect', console.error.bind(console, 'connection error:'));
    return;
    this.db.once('open', function() {
        console.log('opened')
    });
};
TStats.prototype= {
    apiUri      : 'https://api.t411.me',
    apiCredentials: null,
    dbUri       : "",
    db          : null,
    schemas     : {},
    models      : null,

    updateToken : function(onSuccess, onError) {
        logger.info("Authentification de l'utilisateur '%s'", this.apiCredentials.username);
        var r   = request({
            uri     : (this.apiUri+'/auth'),
            method  : 'POST',
            form    : this.apiCredentials
        }, function(error, response, body) {
            var authResult  = JSON.parse(body);
            if (authResult.error) {
                logger.warn("L'authentification a échouée: (%d) %s", authResult.code, authResult.error);
                if (typeof onError ==='function') onError();
            } else {
                logger.info("Authentification réussie");
                this.apiCredentials.token = authResult.token;
                if (typeof onSuccess ==='function') onSuccess();
            }

        }.bind(this));
    },

    prebuildApiRequest  : function(path) {
        return {
            uri         : this.apiUri+path,
            headers     : { 'Authorization': this.apiCredentials.token}
        };
    },

    updateCategories : function(onSuccess, onError) {
        logger.info("Démarrage de la mise à jour des catégories");
        var reqOpt = this.prebuildApiRequest('/categories/tree');
        request(reqOpt, function(error, response, body) {
            var reqResult   = JSON.parse(body);
            var catCounter  = 0;

            var saveCategory    = function(aServerCat) {
                var mCat    = this.models.category.create({
                    _id :aServerCat.id,
                    pid :aServerCat.pid,
                    name:aServerCat.name}, function(err, savedModel) {
                    if (err) logger.error("La catégorie '%s' n'a pu être ajoutée", aServerCat.name);
                    else logger.debug("La catégorie '%s' a été ajoutée", aServerCat.name);
                });
            };

            // Parcours des catégories principales
            for (var mainCat in reqResult) {
                var aMainCat= reqResult[mainCat]; catCounter++;
                if ( ! aMainCat.id) continue; // Certaines catégorie sont 'fantôme'
                saveCategory.bind(this)(aMainCat);

                // Parcours des sous-catégories
                for (var subCat in aMainCat.cats) {
                    var aSubCat = aMainCat.cats[subCat]; catCounter++;
                    saveCategory.bind(this)(aSubCat);
                }
            }
            logger.info("%d catégories ont été récupérées et enregistrées", catCounter);

            if (typeof onSuccess ==='function') onSuccess();
        }.bind(this));
    },

    /**Ajoute <qt> torrents qui seront analysés par la suite. Les torrents
     * ajoutés sont les derniers torrent uploadés. Les torrents déjà surveillés
     * seront comptabilisés.
     * @param qt {Number} */
    monitorLastTorrent  : function(qt, callback) {
        logger.info('Démarrage de l\'échantillonnage (taille=%d)', qt);

        /* Il y a un délicat enchainement de fonctions asynchrones
            1. On fait une requete 'search' sur le tracker
            2. Lorsque l'on reçoit la réponse, on créé une 'liste de tâche' à executer
            en parallele
            3. Chaque tâche contient 2 taches à executer en serie: d'abord
            on ajoute l'entrée torrent ENSUITE le status
            4. Lorsque les 2 sous-taches sont terminées alors la tâche est terminée
            5. Lorsque toutes les tâches sont terminée alors monitorLastTorrent
            peut appeler son callback */
        var reqOpt  = this.prebuildApiRequest('/torrents/search/');
        reqOpt.qs   = {limit:qt};
        var r= request(reqOpt, function(error, response, body) {
            var reqResult   = JSON.parse(body.split('\n')[3]);
            var lastTorrents= reqResult.torrents;
            var createRequests = [];

            for (var itTorrent=0; itTorrent < lastTorrents.length; itTorrent++) {
                // Ici, on ajoute les tâches à la liste de tâches paralleles
                createRequests.push(function(tInfo, asyncFinish) {
                    // On mets les 2 sous-taches en series
                    // et en callback on met celui de la tâche!
                    async.series([
                        this.addTorrentEntry.bind(this, tInfo.entry),
                        this.addTorrentStatus.bind(this,tInfo.status)
                    ], asyncFinish);
                }.bind(this, this.extractTorrentInfos(lastTorrents[itTorrent])));
            }

            async.parallel(createRequests, callback);
        }.bind(this));
     },

    extractTorrentInfos : function(tJson) {
        var result  = { entry:{}, status:{}};
        if (typeof tJson ==='number') {
            result.status.isPended = true;
            result.entry._id = result.status.torrent = tJson;
        } else {
            result.entry = {
                _id         : (new Number(tJson.id)).valueOf(),
                added       : new Date(tJson.added),
                size        : (new Number(tJson.size)).valueOf(),
                category    : {_id:(new Number(tJson.category)).valueOf()},
                owner       : {_id:(new Number(tJson.owner)).valueOf(), name:tJson.username}
            };

            result.status= {
                torrent     : {_id:(new Number(tJson.id)).valueOf()},
                name        : tJson.name,
                isVerified  : (tJson.isVerified=='1'),
                isPended    : false,
                qtComments  : (new Number(tJson.comments)).valueOf(),
                qtSeeders   : (new Number(tJson.seeders)).valueOf(),
                qtLeechers  : (new Number(tJson.leechers)).valueOf(),
                date        : Date.now(),
                qtCompleted : (new Number(tJson.times_completed)).valueOf()
            };
        }
        return result;
    },

    /**Ajout un torrent suivi dans la base
     * @param entry {Object} */
    addTorrentEntry  : function(entry, callback) {
        // On vérifie que le torrent n'existe pas déja
        this.models.torrent.findById(entry._id, function(err, oldEntry) {
            if (oldEntry) {
                logger.info('Le torrent %d n\'a pas été ajouté (doublon)', entry._id);
            } else {
                this.models.torrent.create(entry, function(err, savedTorrent) {
                    if (err) logger.error('Le torrent %d n\'a pu être ajouté', entry._id);
                    else logger.info('Le torrent %d a été ajouté', savedTorrent._id);
                });
            }
            if (typeof callback==='function') callback();
        }.bind(this));
    },

    addTorrentStatus    : function(status, callback) {
        /**Ajout d'une entrée de status d'un torrent
         * @param status {Object}
         */
        this.models.status.create(status,  function(err, savedStatus) {
            if (err) {
                logger.error('Le status du torrent %d n\'a pu être ajouté', status.torrent._id);
            } else {
                logger.info('Le status du torrent %d a été ajouté', savedStatus.torrent);
            }
            if (typeof callback ==='function') callback();
        });
    },

    /**Cette méthode vide la base de donnée.
     * @param callback {Function} Fonction appellée lorsque l'opération est terminée
     */
    flushDatabase   : function(callback) {
        logger.warn('Suppression de la base de donnée!');

        var pendedRemoveRequests = 0;
        for (var m in this.models) pendedRemoveRequests++;
        for (var m in this.models) this.models[m].remove().exec(function() {
            if (--pendedRemoveRequests <= 0) callback();
        });
    }
};
(function () {
    var s = this.schemas;
    s.user  = new mongoose.Schema({
        _id         : {type:Number, min:0},
        name        : String
    });

    s.category = new mongoose.Schema({
        _id         : {type:Number, min:0},
        pid         : {type:Number, min:0},
        name        : String
    });

    s.torrentStatus= new mongoose.Schema({
        torrent     : {type:Number, ref: 'torrent'},
        name        : String,
        isVerified  : Boolean,
        isPended    : Boolean,
        qtComments  : {type:Number, min:0},
        qtSeeders   : {type:Number, min:0},
        qtLeechers  : {type:Number, min:0},
        date        : Date,
        qtCompleted : {type:Number, min:0}
    });

    s.torrentEntry= new mongoose.Schema({
        _id         : {type:Number, min:0},
        added       : Date,
        size        : Number,
        category    : {type:Number, ref: 'category'},
        owner       : {type:Number, ref: 'user'},
        status      : {type:mongoose.Schema.Types.ObjectId, ref: 'status'}
    });

    this.models = {
        category    : mongoose.model('category',    s.category),
        user        : mongoose.model('user',        s.user),
        torrent     : mongoose.model('torrent',     s.torrentEntry),
        status      : mongoose.model('status',      s.torrentStatus)
    };
}.bind(TStats.prototype))();

var t=new TStats(dbUri);
t.apiCredentials.username = program.username;
t.apiCredentials.password = program.password;

var tasks = [];
if (program.flush) tasks.push(t.flushDatabase.bind(t));
if (program.initialize) {
    tasks.push(t.updateToken.bind(t));
    tasks.push(t.monitorLastTorrent.bind(t, program.initialize));
}
tasks.push(function(c) {winston.info('Fin de tâche...'); setTimeout(c, 500)}); // Attendre 500ms
tasks.push(process.exit.bind(process, 0)); // puis quitter

async.series(tasks);
