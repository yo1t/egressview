#include "CLibProcBridge.h"

#include <arpa/inet.h>
#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/socket.h>

static const struct in_sockinfo *internet_info(const struct socket_info *socket_info) {
    if (socket_info->soi_kind == SOCKINFO_TCP) {
        return &socket_info->soi_proto.pri_tcp.tcpsi_ini;
    }
    if (socket_info->soi_kind == SOCKINFO_IN) {
        return &socket_info->soi_proto.pri_in;
    }
    return NULL;
}

static int address_to_text(
    const struct in_sockinfo *info,
    int family,
    int remote,
    char output[EGV_ADDRESS_LENGTH]
) {
    const void *address = NULL;
    if (family == AF_INET) {
        address = remote
            ? (const void *)&info->insi_faddr.ina_46.i46a_addr4
            : (const void *)&info->insi_laddr.ina_46.i46a_addr4;
    } else if (family == AF_INET6) {
        address = remote
            ? (const void *)&info->insi_faddr.ina_6
            : (const void *)&info->insi_laddr.ina_6;
    }
    return address != NULL && inet_ntop(family, address, output, EGV_ADDRESS_LENGTH) != NULL;
}

static int is_unspecified_remote(const struct in_sockinfo *info, int family) {
    if (family == AF_INET) {
        return info->insi_faddr.ina_46.i46a_addr4.s_addr == INADDR_ANY;
    }
    if (family == AF_INET6) {
        return IN6_IS_ADDR_UNSPECIFIED(&info->insi_faddr.ina_6);
    }
    return 1;
}

static int append_process_sockets(pid_t pid, EGVSocketRecord *records, int32_t capacity, int32_t count) {
    int fd_bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (fd_bytes <= 0) {
        return count;
    }

    struct proc_fdinfo *fds = malloc((size_t)fd_bytes);
    if (fds == NULL) {
        return count;
    }
    fd_bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, fd_bytes);
    if (fd_bytes <= 0) {
        free(fds);
        return count;
    }

    int fd_count = fd_bytes / PROC_PIDLISTFD_SIZE;
    char process_name[EGV_PROCESS_NAME_LENGTH] = {0};
    if (proc_name(pid, process_name, sizeof(process_name)) <= 0) {
        snprintf(process_name, sizeof(process_name), "pid-%d", pid);
    }

    for (int index = 0; index < fd_count && count < capacity; index++) {
        if (fds[index].proc_fdtype != PROX_FDTYPE_SOCKET) {
            continue;
        }

        struct socket_fdinfo socket_fd = {0};
        int result = proc_pidfdinfo(
            pid,
            fds[index].proc_fd,
            PROC_PIDFDSOCKETINFO,
            &socket_fd,
            sizeof(socket_fd)
        );
        if (result != PROC_PIDFDSOCKETINFO_SIZE) {
            continue;
        }

        const struct socket_info *socket_info = &socket_fd.psi;
        if ((socket_info->soi_family != AF_INET && socket_info->soi_family != AF_INET6) ||
            (socket_info->soi_protocol != IPPROTO_TCP && socket_info->soi_protocol != IPPROTO_UDP)) {
            continue;
        }

        const struct in_sockinfo *info = internet_info(socket_info);
        if (info == NULL || is_unspecified_remote(info, socket_info->soi_family)) {
            continue;
        }
        if (socket_info->soi_protocol == IPPROTO_TCP &&
            socket_info->soi_kind == SOCKINFO_TCP &&
            socket_info->soi_proto.pri_tcp.tcpsi_state == TSI_S_LISTEN) {
            continue;
        }

        EGVSocketRecord *record = &records[count];
        memset(record, 0, sizeof(*record));
        record->process_id = pid;
        strlcpy(record->process_name, process_name, sizeof(record->process_name));
        record->address_family = socket_info->soi_family;
        record->socket_type = socket_info->soi_type;
        record->protocol_number = socket_info->soi_protocol;
        record->local_port = ntohs((uint16_t)info->insi_lport);
        record->remote_port = ntohs((uint16_t)info->insi_fport);
        record->tcp_state = socket_info->soi_kind == SOCKINFO_TCP
            ? socket_info->soi_proto.pri_tcp.tcpsi_state
            : 0;

        if (!address_to_text(info, socket_info->soi_family, 0, record->local_address) ||
            !address_to_text(info, socket_info->soi_family, 1, record->remote_address)) {
            continue;
        }
        count++;
    }

    free(fds);
    return count;
}

int32_t egv_list_internet_sockets(EGVSocketRecord *records, int32_t capacity) {
    if (records == NULL || capacity <= 0) {
        return -EINVAL;
    }

    int pid_bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (pid_bytes <= 0) {
        return errno == 0 ? -EIO : -errno;
    }

    pid_t *pids = calloc(1, (size_t)pid_bytes);
    if (pids == NULL) {
        return -ENOMEM;
    }
    pid_bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, pid_bytes);
    if (pid_bytes <= 0) {
        int error = errno == 0 ? EIO : errno;
        free(pids);
        return -error;
    }

    int32_t count = 0;
    int pid_count = pid_bytes / (int)sizeof(pid_t);
    for (int index = 0; index < pid_count && count < capacity; index++) {
        if (pids[index] > 0) {
            count = append_process_sockets(pids[index], records, capacity, count);
        }
    }
    free(pids);
    return count;
}
