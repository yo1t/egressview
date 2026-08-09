#ifndef CLIBPROC_BRIDGE_H
#define CLIBPROC_BRIDGE_H

#include <stdint.h>

#define EGV_PROCESS_NAME_LENGTH 256
#define EGV_ADDRESS_LENGTH 46

typedef struct {
    int32_t process_id;
    char process_name[EGV_PROCESS_NAME_LENGTH];
    int32_t address_family;
    int32_t socket_type;
    int32_t protocol_number;
    char local_address[EGV_ADDRESS_LENGTH];
    uint16_t local_port;
    char remote_address[EGV_ADDRESS_LENGTH];
    uint16_t remote_port;
    int32_t tcp_state;
} EGVSocketRecord;

// Returns the number of records written, or a negative errno value.
int32_t egv_list_internet_sockets(EGVSocketRecord *records, int32_t capacity);

#endif
