'use strict';
var CryptoJS = require("crypto-js"); // 암호 모듈 (여기선 sha256 사용)
var express = require("express"); // node.js의 웹서버 프레임워크
var bodyParser = require('body-parser'); // post 방식으로 전송된 파라미터 파싱
var WebSocket = require("ws"); //현재 블록체인의 정보를 다른 노드에게 전달
// ws: 웹소켓
var http_port = process.env.HTTP_PORT || 3001; 
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];

class Block { // 블록구조
    constructor(index, previousHash, timestamp, iden_value, send_id, receive_id, merkle_hash, donation_fee, used_fee, remaining_fee, donation_time, hash) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.iden_value = iden_value;
        this.send_id = send_id;
        this.receive_id = receive_id;
        this.merkle_hash = merkle_hash.toString();
        this.donation_fee = donation_fee;
        this.used_fee = used_fee;
        this.remaining_fee = remaining_fee;
        this.donation_time = donation_time;
        this.hash = hash.toString();
    }
}

var sockets = [];
var MessageType = {
    QUERY_LATEST: 0,
    QUERY_ALL: 1,
    RESPONSE_BLOCKCHAIN: 2
};

//첫 블록 생성 함수
var getGenesisBlock = () => {
    return new Block(0, "0", 1465154705, "my genesis block!!", "send_id", "receive_id", "0", 0, 0, 0, 0, "816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7");

};

var blockchain = [getGenesisBlock()]; // 첫 블록 생성 (제네시스 블록)

// initHttpServer() 함수는 HTTP Interface를 구현한 하나의 웹서버 -> express로 표현
var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json()); // json 파서 등록

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain))); // 현재 블록체인의 모든 블록 정보 요청
    app.post('/mineBlock', (req, res) => { // 새로운 블록을 만들어서 블록체인에 추가하는 부분
        var newBlock = generateNextBlock(req.body.iden_value, req.body.send_id, 
        req.body.receive_id, req.body.donation_fee, req.body.used_fee); // 실질적으로 블록생산
        addBlock(newBlock);
        broadcast(responseLatestMsg());
        console.log('block added: ' + JSON.stringify(newBlock));
        res.send();
    });
    app.get('/peers', (req, res) => { // 현재 블록체인에 접속되어있는 모든 노드들의 정보를 요청하는 부분
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });
    app.post('/addPeer', (req, res) => { // 새로운 노드가 현재 블록체인에 추가될 때 호출되는 부분
        connectToPeers([req.body.peer]);
        res.send();
    });
    app.listen(http_port, () => console.log('Listening http on port: ' + http_port)); // express 객체인 app에 http_port를 이용해 리스닝
};


var initP2PServer = () => {
    var server = new WebSocket.Server({port: p2p_port});
    server.on('connection', ws => initConnection(ws));
    console.log('listening websocket p2p port on: ' + p2p_port);

};

var initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
};

var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
        }
    });
};

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};


var generateNextBlock = (blockData, send_id, receive_id, donation_fee, used_fee) => {
    var previousBlock = getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = new Date().getTime() / 1000;
    //var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData, send_id, receive_id);

    
    var remaining_fee = Number(previousBlock.remaining_fee) + Number(donation_fee) - Number(used_fee);
    var donation_time = new Date().getTime() / 1000;
    var merkle_hash = calculateHash2(donation_fee, used_fee, remaining_fee, donation_time);
    var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData, send_id, receive_id, merkle_hash);
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, send_id, receive_id,
     merkle_hash, donation_fee, used_fee, remaining_fee, donation_time, nextHash);
};


var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.iden_value, block.send_id, block.receive_id, block.merkle_hash);
};

var calculateHash = (index, previousHash, timestamp, iden_value, send_id, receive_id, merkle_hash) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + iden_value + send_id + receive_id + merkle_hash).toString();
};

var calculateHash2 = (donation_fee, used_fee, remaining_fee, donation_time) => {
    return CryptoJS.SHA256(donation_fee + used_fee + remaining_fee + donation_time).toString();
};

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
    }
};

var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};

var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed')
        });
    });
};

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain");
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer");
            broadcast(queryAllMsg());
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is not longer than current blockchain. Do nothing');
    }
};

var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

var isValidChain = (blockchainToValidate) => {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

var getLatestBlock = () => blockchain[blockchain.length - 1];
var queryChainLengthMsg = () => ({'type': MessageType.QUERY_LATEST});
var queryAllMsg = () => ({'type': MessageType.QUERY_ALL});
var responseChainMsg = () =>({
    'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
});
var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

connectToPeers(initialPeers);
initHttpServer();
initP2PServer();